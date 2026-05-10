fn main() {
    // Expose the target triple so lib.rs can resolve sidecar binary paths at runtime.
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=TESSERA_TARGET_TRIPLE={target}");
    println!("cargo:rerun-if-env-changed=TESSERA_GOOGLE_WORKSPACE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=TESSERA_GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE");
    tauri_build::build();
}
