mod commands;
mod edit;
mod fast;
mod files;
mod project;
mod ssh;
mod store;
mod terminal;
mod turbo;
mod window_fx;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(commands::AppState::new(store::Store::load(data_dir)));
            if let Some(window) = app.get_webview_window("main") {
                window_fx::install(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_fx::window_fx_ready,
            window_fx::window_fx_normal_rect,
            window_fx::window_fx_freeze,
            window_fx::window_fx_thaw,
            commands::hosts_list,
            commands::host_save,
            commands::host_delete,
            commands::ssh_connect,
            commands::ssh_trust,
            commands::ssh_disconnect,
            commands::ssh_connected,
            commands::ssh_list,
            commands::ssh_mkdir,
            commands::ssh_create_file,
            commands::ssh_delete,
            commands::project_open,
            commands::project_current,
            commands::project_close,
            commands::project_list,
            commands::project_set_target,
            commands::project_exclude,
            commands::project_push,
            commands::local_home,
            commands::local_list,
            commands::local_downloads,
            commands::local_delete,
            commands::local_properties,
            commands::ssh_properties,
            commands::properties_cancel,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_cancel,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::local_read_text,
            commands::local_save_text,
            commands::ssh_read_text,
            commands::ssh_save_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
