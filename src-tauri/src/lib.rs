use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// Returns the PDF path the app was launched with (e.g. when the user
/// double-clicks a .pdf file that is associated with this app on Windows).
#[tauri::command]
fn launch_file(app: tauri::AppHandle) -> Option<String> {
  let path = std::env::args()
    .skip(1)
    .find(|arg| arg.to_lowercase().ends_with(".pdf"))?;
  // Allow the frontend to read the file that was handed to us by the OS.
  let _ = app.fs_scope().allow_file(&path);
  Some(path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![launch_file])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("PDF Editor");
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
