use serde::Serialize;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

// ── Estruturas ───────────────────────────────────────────────

#[derive(Serialize)]
struct FileInfo {
    name: String,
    size: u64,
}

// ── FFmpeg ───────────────────────────────────────────────────

/// Localiza o FFmpeg: primeiro junto ao executável, depois no PATH do sistema
fn find_ffmpeg(app: &tauri::AppHandle) -> String {
    if let Ok(res) = app.path().resource_dir() {
        let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        let p = res.join(name);
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    if cfg!(windows) { "ffmpeg.exe".into() } else { "ffmpeg".into() }
}

/// Executa FFmpeg com os argumentos dados pelo frontend
#[tauri::command]
async fn ffmpeg_exec(app: tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    let ffmpeg = find_ffmpeg(&app);

    let output = tokio::process::Command::new(&ffmpeg)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!(
            "FFmpeg não encontrado. Instale o FFmpeg e adicione ao PATH.\nDetalhe: {}", e
        ))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let relevant: String = stderr
            .lines()
            .filter(|l| !l.is_empty())
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(relevant)
    }
}

// ── Sessão / Temp ────────────────────────────────────────────

#[tauri::command]
fn get_temp_path(session_id: String, filename: String) -> Result<String, String> {
    let dir = std::env::temp_dir()
        .join("zabiss-editor")
        .join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(filename).to_string_lossy().to_string())
}

#[tauri::command]
fn clean_session(session_id: String) -> Result<(), String> {
    let dir = std::env::temp_dir()
        .join("zabiss-editor")
        .join(&session_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Arquivo I/O ──────────────────────────────────────────────

#[tauri::command]
fn get_file_info(path: String) -> Result<FileInfo, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "arquivo".to_string());
    Ok(FileInfo { name, size: meta.len() })
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&path, data).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn copy_file(src: String, dest: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&dest).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::copy(&src, &dest)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Auto-Updater ─────────────────────────────────────────────

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes:   String,
}

/// Verifica se há uma versão nova disponível no GitHub Releases
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(UpdateInfo {
            version: u.version.clone(),
            notes:   u.body.clone().unwrap_or_default(),
        })),
        Ok(None)    => Ok(None),
        Err(e)      => Err(e.to_string()),
    }
}

/// Baixa e instala a atualização, depois reinicia o app
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

// ── Entry Point ──────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            ffmpeg_exec,
            get_temp_path,
            clean_session,
            get_file_info,
            read_file_bytes,
            write_file_bytes,
            delete_file,
            copy_file,
            open_folder,
            check_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar Zabiss Editor");
}
