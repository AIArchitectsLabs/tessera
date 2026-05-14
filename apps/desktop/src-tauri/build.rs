fn main() {
    // Expose the target triple so lib.rs can resolve sidecar binary paths at runtime.
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=TESSERA_TARGET_TRIPLE={target}");
    println!("cargo:rerun-if-env-changed=TESSERA_GOOGLE_WORKSPACE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=TESSERA_GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE");
    println!("cargo:rerun-if-env-changed=TESSERA_GWS_CLI_URL");
    println!("cargo:rerun-if-env-changed=TESSERA_GWS_CLI_SHA256");
    println!("cargo:rerun-if-env-changed=TESSERA_GWS_CLI_VERSION");
    println!("cargo:rerun-if-env-changed=TESSERA_GWS_CLI_SIZE_BYTES");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_RENDER_URL");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_RENDER_SHA256");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_RENDER_VERSION");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_RENDER_SIZE_BYTES");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_RENDER_ARCHIVE_KIND");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_RENDER_ARCHIVE_ENTRY");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_TRANSFORM_URL");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_TRANSFORM_SHA256");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_TRANSFORM_VERSION");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_TRANSFORM_SIZE_BYTES");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_TRANSFORM_ARCHIVE_KIND");
    println!("cargo:rerun-if-env-changed=TESSERA_PDF_TRANSFORM_ARCHIVE_ENTRY");
    println!("cargo:rerun-if-env-changed=TESSERA_PYTHON_RUNNER_URL");
    println!("cargo:rerun-if-env-changed=TESSERA_PYTHON_RUNNER_SHA256");
    println!("cargo:rerun-if-env-changed=TESSERA_PYTHON_RUNNER_VERSION");
    println!("cargo:rerun-if-env-changed=TESSERA_PYTHON_RUNNER_SIZE_BYTES");
    println!("cargo:rerun-if-env-changed=TESSERA_PYTHON_RUNNER_ARCHIVE_KIND");
    println!("cargo:rerun-if-env-changed=TESSERA_PYTHON_RUNNER_ARCHIVE_ENTRY");
    tauri_build::build();
}
