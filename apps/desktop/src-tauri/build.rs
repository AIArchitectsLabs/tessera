fn main() {
    // Expose the target triple so lib.rs can resolve sidecar binary paths at runtime.
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=TESSERA_TARGET_TRIPLE={target}");
    tauri_build::build();
}
