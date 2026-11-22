use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 后端只监听本机回环地址
const BACKEND_HOST: &str = "127.0.0.1";
/// 开发版固定端口：`npm run dev` 里的 wait-on 与后端都依赖它，必须与
/// apps/server/src/config.ts 的默认端口、apps/desktop/src/api/http.ts 的 DEV 默认值一致。
/// 发布版不使用该端口，而是向系统申请空闲端口，避免与其它软件冲突。
const DEV_BACKEND_PORT: u16 = 17890;
/// 通知后端监听端口的环境变量（与 apps/server/src/config.ts 一致）
const BACKEND_PORT_ENV: &str = "FM_PORT";
/// 等待后端就绪的最长时间（首次启动要加载原生模块并建库，留足余量）
const BACKEND_READY_TIMEOUT: Duration = Duration::from_secs(60);
/// 前端据此事件得知后端状态，payload 为 bool（true=就绪，false=超时）
const EVENT_BACKEND_READY: &str = "backend-ready";

/// 后端运行状态：端口在窗口创建前就已确定，所以前端总能立即拿到地址
struct Backend {
    port: u16,
    ready: AtomicBool,
    child: Mutex<Option<CommandChild>>,
    /// 后端日志文件路径（发布版才有）
    log_path: Mutex<Option<PathBuf>>,
    /// 后端启动失败的真实原因（进程提前退出、无法启动等），供前端展示
    error: Mutex<Option<String>>,
}

/// 日志单文件上限：超过后在下次启动时轮转为 backend.old.log，避免无限增长
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// UTC 时间戳（不引入时间库，够排查问题用）：`2026-11-22 08:30:01Z`
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil_from_days（Howard Hinnant 算法）：把天数换算成年月日
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

/// 追加一行日志（同时打印到控制台）。写文件失败时静默忽略：日志不能影响主流程。
fn log_line(app: &tauri::AppHandle, line: &str) {
    println!("[Backend] {line}");
    let path = app.state::<Backend>().log_path.lock().unwrap().clone();
    if let Some(path) = path {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "[{}] {line}", timestamp());
        }
    }
}

/// 记录启动失败的原因：写入日志，并保存下来给前端展示
fn set_error(app: &tauri::AppHandle, msg: String) {
    log_line(app, &format!("启动失败: {msg}"));
    *app.state::<Backend>().error.lock().unwrap() = Some(msg);
}

/// 准备日志文件：<数据目录>/logs/backend.log，过大时轮转一次
fn prepare_log_file(data_dir: &std::path::Path) -> Option<PathBuf> {
    let dir = data_dir.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("backend.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("backend.old.log"));
    }
    File::options().create(true).append(true).open(&path).ok()?; // 确认可写
    Some(path)
}

/// Windows：把当前进程放入 Job Object（KILL_ON_JOB_CLOSE）。
///
/// 之后派生的 sidecar（node.exe 及其子进程）会继承该 Job。应用无论是正常退出、
/// 崩溃、被任务管理器结束，还是被 `tauri dev` 重新编译时杀掉，系统都会在 Job 句柄
/// 关闭时一并终止这些子进程，避免残留的后端进程占用端口或锁住 target/debug 下的 exe。
#[cfg(windows)]
fn bind_children_to_app_lifetime() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[Backend] 创建 Job Object 失败");
            return;
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            eprintln!("[Backend] 设置 Job Object 失败（可能已处于其它 Job 中）");
            return;
        }
        // 故意不关闭 job 句柄：进程退出时由系统关闭，从而触发 KILL_ON_JOB_CLOSE
    }
}

#[cfg(not(windows))]
fn bind_children_to_app_lifetime() {}

/// 去掉 Windows 扩展路径前缀 `\\?\`。
/// Tauri 的 resource_dir() 在 Windows 上返回 `\\?\E:\...` 形式，Node 的 realpathSync
/// 对这种路径会抛 `EISDIR: lstat 'E:'`，导致后端无法启动，所以传给 Node 前必须还原。
fn to_plain_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        // `\\?\UNC\server\share` 还原为 `\\server\share`
        Some(rest) => match rest.strip_prefix(r"UNC\") {
            Some(unc) => format!(r"\\{unc}"),
            None => rest.to_string(),
        },
        None => s,
    }
}

/// 选择后端端口：debug 用固定端口；release 向系统申请空闲端口。
///
/// 申请到端口后立即释放监听器再交给后端，理论上存在被别的进程抢占的极小窗口；
/// 对本机桌面应用可接受，后端若因端口冲突启动失败，会在日志里暴露并触发前端超时提示。
fn pick_port() -> u16 {
    if cfg!(debug_assertions) {
        return DEV_BACKEND_PORT;
    }
    TcpListener::bind((BACKEND_HOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(DEV_BACKEND_PORT)
}

/// 在后台线程轮询端口，就绪后通知前端。不阻塞窗口创建，所以窗口会立即出现。
fn wait_ready_in_background(app: tauri::AppHandle, port: u16) {
    std::thread::spawn(move || {
        let addr: SocketAddr = format!("{BACKEND_HOST}:{port}")
            .parse()
            .expect("后端地址格式错误");
        let start = Instant::now();
        let mut ready = false;
        while start.elapsed() < BACKEND_READY_TIMEOUT {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                ready = true;
                break;
            }
            // 后端进程已提前退出 / 无法启动：不用再等满超时
            if app.state::<Backend>().error.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        if ready {
            log_line(&app, &format!("服务已就绪 ({addr})，用时 {:.1}s", start.elapsed().as_secs_f32()));
        } else if cfg!(debug_assertions) {
            eprintln!(
                "[Backend] 未检测到开发后端 ({addr})，请使用 `npm run dev` 启动，或单独运行 `npm run dev:server`"
            );
        } else {
            let has_error = app.state::<Backend>().error.lock().unwrap().is_some();
            if !has_error {
                set_error(
                    &app,
                    format!(
                        "等待后端超时（{} 秒）：后端进程在运行，但端口 {port} 一直连不上，可能被杀毒软件或防火墙拦截",
                        BACKEND_READY_TIMEOUT.as_secs()
                    ),
                );
            }
        }

        // 先写状态再发事件：前端错过事件时可通过 is_backend_ready 补查
        let state: State<Backend> = app.state();
        state.ready.store(ready, Ordering::SeqCst);
        let _ = app.emit(EVENT_BACKEND_READY, ready);
    });
}

/// 前端查询后端地址。端口在 setup 之前就已确定，所以总能立即返回。
#[tauri::command]
fn get_backend_url(state: State<Backend>) -> String {
    format!("http://{BACKEND_HOST}:{}", state.port)
}

/// 前端查询后端是否已就绪（用于错过 backend-ready 事件时补查）。
#[tauri::command]
fn is_backend_ready(state: State<Backend>) -> bool {
    state.ready.load(Ordering::SeqCst)
}

/// 前端查询后端启动失败的原因（没有失败返回 None）。
#[tauri::command]
fn get_backend_error(state: State<Backend>) -> Option<String> {
    state.error.lock().unwrap().clone()
}

/// 前端查询后端日志文件路径（开发版没有）。
#[tauri::command]
fn get_log_path(state: State<Backend>) -> Option<String> {
    state
        .log_path
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| to_plain_path(p))
}

/// 在资源管理器里定位并选中日志文件。
#[tauri::command]
fn reveal_log(state: State<Backend>) -> Result<(), String> {
    let path = state
        .log_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "当前没有日志文件".to_string())?;
    #[cfg(windows)]
    {
        // explorer 的 /select, 参数必须与路径写在同一个参数里
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", to_plain_path(&path)))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
    Ok(())
}

/// 启动 Node.js 后端。
/// - 开发模式（`tauri dev`）：后端由根目录 `npm run dev` 统一启动，这里不启动 sidecar，只探测就绪
/// - 发布模式：用随包分发的便携 Node 运行时（sidecar `node`）执行
///   resources/server-dist/server.cjs，数据库放在系统应用数据目录
fn start_backend(app: &tauri::AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(debug_assertions) {
        if let Err(e) = spawn_release_backend(app, port) {
            // 启动前的失败（目录不可写、找不到 sidecar、无法创建进程等）也要让前端看到真实原因
            set_error(app, format!("无法启动后端进程: {e}"));
        }
    }

    wait_ready_in_background(app.clone(), port);
    Ok(())
}

/// 发布版：启动 sidecar，并把它的输出写入日志文件。任何一步失败都返回错误由调用方记录。
fn spawn_release_backend(app: &tauri::AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("无法创建数据目录 {}: {e}", to_plain_path(&data_dir)))?;
    let db_path = data_dir.join("finance.db");

    // 日志文件打不开也不影响启动，只是不落盘
    *app.state::<Backend>().log_path.lock().unwrap() = prepare_log_file(&data_dir);
    log_line(app, "==================== 应用启动 ====================");
    log_line(app, &format!("版本 {}  系统 {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS));
    log_line(app, &format!("数据目录: {}", to_plain_path(&data_dir)));
    log_line(app, &format!("数据库: {}", to_plain_path(&db_path)));

    let server_js = app
        .path()
        .resource_dir()?
        .join("server-dist")
        .join("server.cjs");
    log_line(app, &format!("后端脚本: {}（存在: {}）", to_plain_path(&server_js), server_js.exists()));
    if !server_js.exists() {
        return Err(format!("找不到后端脚本 {}，安装可能不完整或被杀毒软件删除", to_plain_path(&server_js)).into());
    }

    let command = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("找不到随包的 Node 运行时（可能被杀毒软件删除）: {e}"))?
        .args([to_plain_path(&server_js)])
        .env("FM_DB_PATH", to_plain_path(&db_path))
        .env(BACKEND_PORT_ENV, port.to_string())
        // 关闭窗口时 stdin 被关闭，后端据此自行退出，与 Job Object 形成双重保障
        .env("FM_EXIT_ON_STDIN_CLOSE", "1");

    log_line(app, &format!("正在启动 Node 后端 (端口 {port})..."));
    let (mut rx, child) = command.spawn().map_err(|e| format!("创建后端进程失败: {e}"))?;
    app.state::<Backend>().child.lock().unwrap().replace(child);

    // 转发 sidecar 输出到日志；进程提前退出视为启动失败
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log_line(&handle, String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Stderr(line) => {
                    log_line(&handle, &format!("[stderr] {}", String::from_utf8_lossy(&line).trim_end()));
                }
                CommandEvent::Error(err) => {
                    log_line(&handle, &format!("[ERROR] {err}"));
                }
                CommandEvent::Terminated(payload) => {
                    log_line(&handle, &format!("进程已终止: {payload:?}"));
                    // 应用正常退出时 stop_backend 会 kill，此时 ready 已为 true，不算失败
                    if !handle.state::<Backend>().ready.load(Ordering::SeqCst) {
                        set_error(
                            &handle,
                            format!(
                                "后端进程启动后立即退出（退出码 {:?}），详见日志",
                                payload.code
                            ),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn stop_backend(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<Backend>().child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

pub fn run() {
    // 必须在派生任何子进程之前调用，子进程才会继承 Job
    bind_children_to_app_lifetime();

    let port = pick_port();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend {
            port,
            ready: AtomicBool::new(false),
            child: Mutex::new(None),
            log_path: Mutex::new(None),
            error: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_url,
            is_backend_ready,
            get_backend_error,
            get_log_path,
            reveal_log
        ])
        .setup(move |app| {
            start_backend(app.handle(), port)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_backend(handle);
        }
    });
}
