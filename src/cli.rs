use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use crate::{bridge::BrowserBridge, client, http, output, settings::Settings};

const DEFAULT_PORT: u16 = 3500;

#[derive(Debug, Parser)]
#[command(name = "bro")]
#[command(about = "Rust-native local MCP core for browser automation")]
pub struct Args {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the local HTTP/WebSocket/MCP server.
    Serve(ServeArgs),
    /// Call a tool on the local MCP server.
    Call(CallArgs),
    /// Run read-only diagnostics.
    Doctor(DoctorArgs),
}

#[derive(Debug, Parser)]
struct ServeArgs {
    /// Local port to bind on 127.0.0.1.
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Debug, Parser)]
struct DoctorArgs {
    /// Emit diagnostics as JSON on stdout.
    #[arg(long)]
    json: bool,

    /// Local port expected for the server.
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Debug, Parser)]
struct CallArgs {
    /// Tool name, for example browser.batch.run.
    tool: String,

    /// Tool arguments as a JSON object. Defaults to {}.
    arguments: Option<String>,

    /// Emit the full JSON-RPC response instead of text content.
    #[arg(long)]
    json: bool,

    /// Local port where the server is listening.
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
}

pub async fn run() -> Result<()> {
    let args = Args::parse();
    match args
        .command
        .unwrap_or(Command::Serve(ServeArgs { port: DEFAULT_PORT }))
    {
        Command::Serve(args) => serve(args).await,
        Command::Call(args) => call(args).await,
        Command::Doctor(args) => doctor(args).await,
    }
}

async fn serve(args: ServeArgs) -> Result<()> {
    init_tracing();

    let settings = Settings::load_or_create().context("failed to load settings")?;
    let bind = loopback_addr(args.port);
    let bridge = BrowserBridge::new();

    tracing::info!(%bind, settings = %settings.path().display(), "starting server");
    http::serve(http::ServerConfig {
        bind,
        token: settings.token().to_owned(),
        bridge,
    })
    .await
}

async fn doctor(args: DoctorArgs) -> Result<()> {
    let settings = Settings::load_or_create().context("failed to load settings")?;
    let report = output::DoctorReport {
        settings_path: settings.path().to_path_buf(),
        token_present: !settings.token().is_empty(),
        bind_address: loopback_addr(args.port),
    };

    if args.json {
        output::write_json_stdout(&report)
    } else {
        output::write_doctor_human(&report)
    }
}

async fn call(args: CallArgs) -> Result<()> {
    let settings = Settings::load_or_create().context("failed to load settings")?;
    let arguments = parse_call_arguments(args.arguments)?;
    let response = client::call_tool(
        loopback_addr(args.port),
        settings.token(),
        &args.tool,
        arguments,
    )?;

    if args.json {
        output::write_json_stdout(&response)
    } else {
        output::write_tool_call_human(&response)
    }
}

fn parse_call_arguments(arguments: Option<String>) -> Result<serde_json::Value> {
    let Some(arguments) = arguments else {
        return Ok(serde_json::json!({}));
    };
    let value = serde_json::from_str::<serde_json::Value>(&arguments)
        .with_context(|| format!("failed to parse tool arguments JSON: {arguments}"))?;
    if !value.is_object() {
        anyhow::bail!("tool arguments must be a JSON object");
    }
    Ok(value)
}

fn loopback_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

fn init_tracing() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .init();
}
