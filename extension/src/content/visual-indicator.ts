// Content script: injected into all pages at document_idle
// Provides visual feedback (pulsing border + stop button) during agentic sessions.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BORDER_COLOR = '#2563EB'
const BORDER_GLOW = 'rgba(37,99,235,0.16)'
const BORDER_WIDTH = 1
const ANIMATION_NAME = 'obm-pulse'
const BORDER_ID = 'obm-visual-border'
const TOOLBAR_ID = 'obm-toolbar'
const BANNER_ID = 'obm-static-banner'
const STYLE_ID = 'obm-style'

// ---------------------------------------------------------------------------
// Inject CSS animation styles
// ---------------------------------------------------------------------------

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @keyframes ${ANIMATION_NAME} {
      0%   { box-shadow: 0 0 0 0 ${BORDER_GLOW}, inset 0 0 0 0 ${BORDER_GLOW}; opacity: 0.28; }
      50%  { box-shadow: 0 0 10px 1px ${BORDER_GLOW}, inset 0 0 6px 1px ${BORDER_GLOW}; opacity: 0.18; }
      100% { box-shadow: 0 0 0 0 ${BORDER_GLOW}, inset 0 0 0 0 ${BORDER_GLOW}; opacity: 0.28; }
    }
    @keyframes obm-spinner {
      to { transform: rotate(360deg); }
    }
    #${BORDER_ID} {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2147483647;
      box-sizing: border-box;
      border: ${BORDER_WIDTH}px solid rgba(37,99,235,0.38);
      animation: ${ANIMATION_NAME} 2s ease-in-out infinite;
    }
    #${TOOLBAR_ID} {
      position: fixed;
      bottom: 14px;
      right: 14px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 6px;
      opacity: 0.42;
      background: rgba(15,23,42,0.36);
      border: 1px solid rgba(37,99,235,0.24);
      border-radius: 7px;
      padding: 3px 4px 3px 7px;
      font-size: 10px;
      font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
      font-weight: 500;
      letter-spacing: 0;
      box-shadow: 0 2px 10px rgba(0,0,0,0.16);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: opacity 0.12s, background 0.12s, border-color 0.12s;
    }
    #${TOOLBAR_ID}:hover {
      opacity: 0.9;
      background: rgba(15,23,42,0.78);
      border-color: rgba(37,99,235,0.45);
    }
    #${TOOLBAR_ID} .obm-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: ${BORDER_COLOR};
      box-shadow: 0 0 7px ${BORDER_COLOR};
      flex-shrink: 0;
      animation: obm-dot-pulse 2s ease-in-out infinite;
    }
    @keyframes obm-dot-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 7px ${BORDER_COLOR}; }
      50% { opacity: 0.5; box-shadow: 0 0 3px ${BORDER_COLOR}; }
    }
    #${TOOLBAR_ID} .obm-label {
      color: rgba(203,213,225,0.82);
      white-space: nowrap;
    }
    #${TOOLBAR_ID} .obm-divider {
      width: 1px;
      height: 12px;
      background: rgba(37,99,235,0.18);
      flex-shrink: 0;
    }
    #${TOOLBAR_ID} .obm-stop {
      background: rgba(37,99,235,0.08);
      border: 1px solid rgba(37,99,235,0.22);
      border-radius: 5px;
      color: rgba(147,197,253,0.86);
      cursor: pointer;
      font-size: 10px;
      font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
      font-weight: 600;
      padding: 1px 6px;
      letter-spacing: 0;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
      white-space: nowrap;
    }
    #${TOOLBAR_ID} .obm-stop:hover {
      background: rgba(37,99,235,0.28);
      border-color: rgba(37,99,235,0.7);
      color: #bfdbfe;
    }
    #${BANNER_ID} {
      position: fixed;
      bottom: 14px;
      right: 14px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 6px;
      opacity: 0.34;
      background: rgba(15,23,42,0.3);
      color: rgba(148,163,184,0.82);
      border: 1px solid rgba(37,99,235,0.14);
      border-radius: 7px;
      padding: 3px 6px 3px 7px;
      font-size: 10px;
      font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
      font-weight: 500;
      letter-spacing: 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      transition: opacity 0.12s, background 0.12s, border-color 0.12s;
    }
    #${BANNER_ID}:hover {
      opacity: 0.85;
      background: rgba(15,23,42,0.72);
      border-color: rgba(37,99,235,0.3);
    }
    #${BANNER_ID}::before {
      content: '';
      display: inline-block;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #334155;
      flex-shrink: 0;
    }
    #${BANNER_ID} button {
      background: transparent;
      border: none;
      color: rgba(148,163,184,0.62);
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      padding: 0 1px;
      transition: color 0.12s;
    }
    #${BANNER_ID} button:hover {
      color: #64748b;
    }
  `
  document.documentElement.appendChild(style)
}

// ---------------------------------------------------------------------------
// Active indicator (pulsing border + stop button)
// ---------------------------------------------------------------------------

function showIndicator(): void {
  ensureStyles()

  // Remove static banner if present (transitioning back to active)
  document.getElementById(BANNER_ID)?.remove()

  // Create border overlay if not present
  if (!document.getElementById(BORDER_ID)) {
    const border = document.createElement('div')
    border.id = BORDER_ID
    document.documentElement.appendChild(border)
  }

  // Create toolbar (label + stop button) if not present
  if (!document.getElementById(TOOLBAR_ID)) {
    const toolbar = document.createElement('div')
    toolbar.id = TOOLBAR_ID

    const dot = document.createElement('span')
    dot.className = 'obm-dot'

    const label = document.createElement('span')
    label.className = 'obm-label'
    label.textContent = 'Agent is active'

    const divider = document.createElement('span')
    divider.className = 'obm-divider'

    const stopBtn = document.createElement('button')
    stopBtn.className = 'obm-stop'
    stopBtn.textContent = 'Stop'
    stopBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_AGENT' }, () => {
        void chrome.runtime.lastError
      })
    })

    toolbar.appendChild(dot)
    toolbar.appendChild(label)
    toolbar.appendChild(divider)
    toolbar.appendChild(stopBtn)
    document.documentElement.appendChild(toolbar)
  }
}

function hideIndicator(): void {
  document.getElementById(BORDER_ID)?.remove()
  document.getElementById(TOOLBAR_ID)?.remove()
}

// ---------------------------------------------------------------------------
// Static banner ("Agent is active")
// ---------------------------------------------------------------------------

function showStaticBanner(): void {
  ensureStyles()

  if (document.getElementById(BANNER_ID)) return

  const banner = document.createElement('div')
  banner.id = BANNER_ID

  const label = document.createElement('span')
  label.textContent = 'Agent is active'

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', 'Dismiss')
  closeBtn.addEventListener('click', () => {
    banner.remove()
  })

  banner.appendChild(label)
  banner.appendChild(closeBtn)
  document.documentElement.appendChild(banner)
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message
    ) {
      const { type } = message as { type: string }
      if (type === 'INDICATOR_SHOW') {
        showIndicator()
        sendResponse({ ok: true })
        return true
      }
      if (type === 'INDICATOR_HIDE') {
        hideIndicator()
        showStaticBanner()
        sendResponse({ ok: true })
        return true
      }
    }
    return false
  },
)

export {}
