use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// 持有 sidecar 子进程句柄，应用退出时负责终止，避免残留后台进程
struct SidecarState(Mutex<Option<CommandChild>>);

/// 启动 Node.js 后端。
/// - 开发模式（`tauri dev`）：由 `npm run dev:server` 单独启动后端，这里不启动 sidecar
/// - 发布模式：用随包分发的便携 Node 运行时（sidecar `node`）执行 resources/server-dist/server.cjs，
///   数据库放在系统应用数据目录
fn start_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        return Ok(());
    }

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
        .args([server_js.to_string_lossy().to_string()])
        .env("FM_DB_PATH", db_path.to_string_lossy().to_string())
        // 关闭窗口时 stdin 被关闭，后端据此自行退出，双重保障不残留进程
        .env("FM_EXIT_ON_STDIN_CLOSE", "1");

    let (_rx, child) = command.spawn()?;
    app.state::<SidecarState>().0.lock().unwrap().replace(child);
    Ok(())
}

fn stop_sidecar(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<SidecarState>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            start_sidecar(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_sidecar(handle);
        }
    });
}
