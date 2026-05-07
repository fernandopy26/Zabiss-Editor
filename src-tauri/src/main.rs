// Impede que o terminal abra junto com o app no Windows em release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zabiss_editor_lib::run()
}
