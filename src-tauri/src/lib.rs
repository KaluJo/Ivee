use screenshots::Screen;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tesseract::Tesseract;

use cheetah::CheetahBuilder;
use porcupine::PorcupineBuilder;
use pv_recorder::PvRecorderBuilder;
use rhino::RhinoBuilder;

use base64::encode as base64_encode;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;

static LISTENING: AtomicBool = AtomicBool::new(false);
static LAST_DETECTED_KEYWORD: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
pub struct KeywordDetection {
    keyword: String,
    timestamp: String,
}

#[derive(Serialize)]
struct ScreenshotResult {
    text: String,
    image: String,
}

static RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
async fn listen_for_consent(access_key: String) -> Result<String, String> {
    if RECORDING_ACTIVE.load(Ordering::SeqCst) {
        return Err("Recording already in progress".to_string());
    }

    println!("Starting consent detection...");

    let rhino = RhinoBuilder::new(&access_key, "./resources/verbal_consent.rhn")
        .init()
        .map_err(|e| format!("Failed to initialize Rhino: {}", e))?;

    let recorder = PvRecorderBuilder::new(rhino.frame_length() as i32)
        .device_index(-1)
        .init()
        .map_err(|e| format!("Failed to initialize recorder: {}", e))?;

    RECORDING_ACTIVE.store(true, Ordering::SeqCst);

    let cleanup = |recorder: &pv_recorder::PvRecorder| {
        if let Err(e) = recorder.stop() {
            println!("Warning: Failed to stop recorder: {}", e);
        }
        RECORDING_ACTIVE.store(false, Ordering::SeqCst);
    };

    match recorder.start() {
        Ok(_) => {
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(e) => {
            cleanup(&recorder);
            return Err(format!("Failed to start recording: {}", e));
        }
    }

    println!("Listening for verbal consent...");

    let start_time = Instant::now();
    let timeout = Duration::from_secs(3);
    let mut result = "denied".to_string();

    'recording: while start_time.elapsed() < timeout {
        match recorder.read() {
            Ok(frame) => match rhino.process(&frame) {
                Ok(is_finalized) => {
                    if is_finalized {
                        match rhino.get_inference() {
                            Ok(inference) => {
                                if true {
                                    println!("Detected intent: {}", intent);
                                    if intent == "allow" {
                                        println!("Consent detected: allow");
                                        result = "allowed".to_string();
                                        break 'recording;
                                    }
                                }
                            }
                            Err(e) => {
                                println!("Failed to get inference: {}", e);
                            }
                        }
                    }
                }
                Err(e) => {
                    println!("Warning: Failed to process audio frame: {}", e);
                }
            },
            Err(e) => {
                cleanup(&recorder);
                return Err(format!("Failed to read audio frame: {}", e));
            }
        }
    }

    cleanup(&recorder);
    println!("Consent detection completed with result: {}", result);

    Ok(result)
}

#[tauri::command]
async fn listen_for_speech(access_key: String) -> Result<String, String> {
    println!("Starting speech recognition...");

    let cheetah = CheetahBuilder::new()
        .access_key(&access_key)
        .init()
        .map_err(|e| format!("Failed to initialize Cheetah: {}", e))?;

    let recorder = PvRecorderBuilder::new(cheetah.frame_length() as i32)
        .device_index(-1)
        .init()
        .map_err(|e| format!("Failed to initialize recorder: {}", e))?;

    recorder
        .start()
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    println!("Listening for speech...");
    let start_time = Instant::now();
    let timeout = Duration::from_secs(5);
    let mut transcription = String::new();

    while start_time.elapsed() < timeout {
        let frame = recorder
            .read()
            .map_err(|e| format!("Failed to read audio frame: {}", e))?;

        if let Ok(cheetah_transcript) = cheetah.process(&frame) {
            transcription.push_str(&cheetah_transcript.transcript);
            if cheetah_transcript.is_endpoint {
                if let Ok(flush_transcript) = cheetah.flush() {
                    transcription.push_str(&flush_transcript.transcript);
                }
                break;
            }
        }
    }

    recorder.stop().ok();
    println!("Speech recognition completed: {}", transcription);

    Ok(transcription)
}

#[tauri::command]
fn start_keyword_detection(access_key: String) -> Result<(), String> {
    if LISTENING.load(Ordering::SeqCst) {
        return Ok(());
    }

    std::thread::spawn(move || {
        let porcupine = PorcupineBuilder::new_with_keyword_paths(
            &access_key,
            &[
                "./resources/hey_ivee.ppn",
                "./resources/what_do_you_see.ppn",
            ],
        )
        .init()
        .expect("Failed to create Porcupine");

        let recorder = PvRecorderBuilder::new(porcupine.frame_length() as i32)
            .device_index(-1)
            .init()
            .expect("Failed to initialize pvrecorder");

        recorder.start().expect("Failed to start audio recording");

        LISTENING.store(true, Ordering::SeqCst);
        while LISTENING.load(Ordering::SeqCst) {
            let frame = recorder.read().expect("Failed to read audio frame");
            if let Ok(keyword_index) = porcupine.process(&frame) {
                if keyword_index >= 0 {
                    let detected = format!("Keyword {} detected", keyword_index);
                    let mut last_keyword = LAST_DETECTED_KEYWORD.lock().unwrap();
                    *last_keyword = Some(detected);
                }
            }
        }

        recorder.stop().expect("Failed to stop audio recording");
    });

    Ok(())
}

#[tauri::command]
fn stop_keyword_detection() -> Result<(), String> {
    LISTENING.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn get_last_keyword() -> Option<String> {
    let mut last_keyword = LAST_DETECTED_KEYWORD.lock().unwrap();
    let keyword = last_keyword.clone();
    *last_keyword = None;
    keyword
}

#[tauri::command]
fn take_screenshot_and_ocr() -> Result<ScreenshotResult, String> {
    let start = Instant::now();
    let screens = Screen::all().map_err(|e| e.to_string())?;

    if let Some(screen) = screens.first() {
        let image = screen.capture().map_err(|e| e.to_string())?;

        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join(format!("screenshot_{}.png", screen.display_info.id));
        image.save(&file_path).map_err(|e| e.to_string())?;

        let image_path = file_path
            .to_str()
            .ok_or("Failed to convert file path to string")?;

        let mut tess = Tesseract::new(None, Some("eng"))
            .map_err(|e| e.to_string())?
            .set_image(image_path)
            .map_err(|e| e.to_string())?
            .recognize()
            .map_err(|e| e.to_string())?;

        let extracted_text = tess.get_text().map_err(|e| e.to_string())?;

        let image_data = fs::read(&file_path).map_err(|e| e.to_string())?;
        let base64_image = base64_encode(image_data);

        if let Err(e) = fs::remove_file(&file_path) {
            println!("Warning: Failed to remove temporary screenshot: {}", e);
        }

        println!("Screenshot and OCR completed in {:?}", start.elapsed());

        Ok(ScreenshotResult {
            text: extracted_text,
            image: base64_image,
        })
    } else {
        Err("No screens found.".to_string())
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            take_screenshot_and_ocr,
            start_keyword_detection,
            stop_keyword_detection,
            get_last_keyword,
            listen_for_consent,
            listen_for_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
