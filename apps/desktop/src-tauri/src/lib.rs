use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
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
            std::thread::sleep(Duration::from_millis(100));
        }

        if ready {
            println!("[Backend] 服务已就绪 ({addr})，用时 {:.1}s", start.elapsed().as_secs_f32());
        } else if cfg!(debug_assertions) {
            eprintln!(
                "[Backend] 未检测到开发后端 ({addr})，请使用 `npm run dev` 启动，或单独运行 `npm run dev:server`"
            );
        } else {
            eprintln!(
                "[Backend] 等待后端超时 ({}s)，请检查后端日志",
                BACKEND_READY_TIMEOUT.as_secs()
            );
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

/// 启动 Node.js 后端。
/// - 开发模式（`tauri dev`）：后端由根目录 `npm run dev` 统一启动，这里不启动 sidecar，只探测就绪
/// - 发布模式：用随包分发的便携 Node 运行时（sidecar `node`）执行
///   resources/server-dist/server.cjs，数据库放在系统应用数据目录
fn start_backend(app: &tauri::AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(debug_assertions) {
        let data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("finance.db");

        let server_js = app
            .path()
            .resource_dir()?
            .join("server-dist")
            .join("server.cjs");

        let command = app
            .shell()
            .sidecar("node")?
            .args([to_plain_path(&server_js)])
            .env("FM_DB_PATH", to_plain_path(&db_path))
            .env(BACKEND_PORT_ENV, port.to_string())
            // 关闭窗口时 stdin 被关闭，后端据此自行退出，与 Job Object 形成双重保障
            .env("FM_EXIT_ON_STDIN_CLOSE", "1");

        println!("[Backend] 正在启动 Node 后端 (端口 {port})...");
        let (mut rx, child) = command.spawn()?;
        app.state::<Backend>().child.lock().unwrap().replace(child);

        // 转发 sidecar 输出，便于排查后端启动失败
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        println!("[Backend] {}", String::from_utf8_lossy(&line).trim_end());
                    }
                    CommandEvent::Stderr(line) => {
                        eprintln!("[Backend] {}", String::from_utf8_lossy(&line).trim_end());
                    }
                    CommandEvent::Error(err) => eprintln!("[Backend ERROR] {err}"),
                    CommandEvent::Terminated(payload) => {
                        println!("[Backend] 进程已终止: {payload:?}");
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    wait_ready_in_background(app.clone(), port);
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
        })
        .invoke_handler(tauri::generate_handler![get_backend_url, is_backend_ready])
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
