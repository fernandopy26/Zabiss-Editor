use serde::Serialize;
use std::path::Path;
use tauri::{Manager, Emitter};
use base64::{Engine as _, engine::general_purpose};
use futures_util::StreamExt;

// ── Estruturas ───────────────────────────────────────────────

#[derive(Serialize)]
struct FileInfo {
    name: String,
    size: u64,
}

// ── FFmpeg ───────────────────────────────────────────────────

fn find_ffmpeg(app: &tauri::AppHandle) -> String {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Ok(res) = app.path().resource_dir() {
        // 1. Empacotado como resource em binaries/ffmpeg
        let bundled = res.join("binaries").join(name);
        if bundled.exists() {
            return bundled.to_string_lossy().to_string();
        }
        // 2. Direto na pasta de resources
        let direct = res.join(name);
        if direct.exists() {
            return direct.to_string_lossy().to_string();
        }
    }
    // 3. Fallback: FFmpeg do PATH do sistema (modo dev)
    name.to_string()
}

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

// ── Mídia: duração e extração de frame (via FFmpeg) ──────────

/// Obtém a duração de um arquivo de mídia em segundos
#[tauri::command]
async fn get_media_duration(app: tauri::AppHandle, path: String) -> Result<f64, String> {
    let ffmpeg = find_ffmpeg(&app);
    let output = tokio::process::Command::new(&ffmpeg)
        .args(["-i", &path, "-f", "null", "-"])
        .output()
        .await
        .map_err(|e| format!("FFmpeg falhou: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if let Some(idx) = line.find("Duration: ") {
            let after  = &line[idx + 10..];
            let dur_s  = after.split(',').next().unwrap_or("").trim();
            let parts: Vec<&str> = dur_s.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                return Ok(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    Err(format!("Não foi possível extrair duração. FFmpeg disse: {}",
        stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")))
}

/// Extrai um frame em determinado tempo e retorna como JPEG em base64
#[tauri::command]
async fn extract_frame_at(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
    time_sec: f64,
) -> Result<String, String> {
    let ffmpeg = find_ffmpeg(&app);
    let dir = std::env::temp_dir().join("zabiss-editor").join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("frame_{}.jpg", (time_sec * 1000.0) as u64));

    let output = tokio::process::Command::new(&ffmpeg)
        .args([
            "-ss", &time_sec.to_string(),
            "-i",  &path,
            "-vframes", "1",
            "-q:v", "3",
            "-vf",  "scale='min(1280,iw)':-2",
            "-y",
            out.to_str().unwrap(),
        ])
        .output()
        .await
        .map_err(|e| format!("FFmpeg falhou ao extrair frame: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | "));
    }

    let bytes = tokio::fs::read(&out).await.map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&out).await;
    Ok(general_purpose::STANDARD.encode(&bytes))
}

// ── Auto-Updater (download direto + abertura do instalador) ──

#[derive(Clone, Serialize)]
struct UpdateProgress {
    received: u64,
    total: u64,
}

/// Baixa o instalador da nova versão para uma pasta temp,
/// emitindo eventos 'update-progress' durante o download.
/// Retorna o caminho completo do arquivo baixado.
#[tauri::command]
async fn download_update_file(
    app: tauri::AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("zabiss-editor-update");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_path = temp_dir.join(&filename);

    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&temp_path).await.map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;

    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        received += bytes.len() as u64;

        let _ = app.emit("update-progress", UpdateProgress { received, total });
    }

    file.flush().await.map_err(|e| e.to_string())?;
    Ok(temp_path.to_string_lossy().to_string())
}

/// Abre o instalador com o handler padrão do SO.
/// Windows: Windows Installer abre o MSI/EXE
/// macOS: monta o DMG
/// Linux .deb: abre Software Center / GDebi
/// Linux .AppImage: torna executável e abre a pasta (não dá pra rodar
/// enquanto o atual está rodando — precisa fechar manualmente)
#[tauri::command]
fn open_installer(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path_lower = path.to_lowercase();
        if path_lower.ends_with(".appimage") {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;

            if let Some(parent) = std::path::Path::new(&path).parent() {
                std::process::Command::new("xdg-open")
                    .arg(parent)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        } else {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ── Versão atual do app ──────────────────────────────────────

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ── Entry Point ──────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            get_app_version,
            get_media_duration,
            extract_frame_at,
            download_update_file,
            open_installer,
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar Zabiss Editor");
}
