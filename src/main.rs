use anyhow::Result;

use bro::cli;

#[tokio::main]
async fn main() -> Result<()> {
    cli::run().await
}
