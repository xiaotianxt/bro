package facade

// domExtractScript is the fallback DOM text/link reader for extraction.
const domExtractScript = `(() => {
const textParts = [];
const links = [];
const seenNodes = new Set();
const seenLinks = new Set();

function addText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text) textParts.push(text);
}

function addLink(element) {
  const href = element.href || element.getAttribute("href");
  if (!href || seenLinks.has(href)) return;
  seenLinks.add(href);
  const text = (element.innerText || element.getAttribute("aria-label") || element.textContent || href)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  links.push({ text, url: href, source: "dom" });
}

function isHidden(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
}

function walk(node, depth = 0) {
  if (!node || seenNodes.has(node) || depth > 80) return;
  seenNodes.add(node);

  if (node.nodeType === Node.TEXT_NODE) {
    addText(node.textContent);
    return;
  }

  if (
    node.nodeType !== Node.ELEMENT_NODE &&
    node.nodeType !== Node.DOCUMENT_NODE &&
    node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
  ) {
    return;
  }

  const element = node.nodeType === Node.ELEMENT_NODE ? node : null;
  if (element) {
    if (isHidden(element)) return;
    addText(element.getAttribute("aria-label"));
    if (element.matches("a[href]")) addLink(element);
  }

  for (const child of node.childNodes || []) walk(child, depth + 1);
  if (element && element.shadowRoot) walk(element.shadowRoot, depth + 1);
}

walk(document.body || document.documentElement);

const text = Array.from(new Set(textParts)).join("\n").slice(0, 60000);
return JSON.stringify({
  title: document.title || "",
  url: location.href,
  text,
  links: links.slice(0, 200)
});
})()`
