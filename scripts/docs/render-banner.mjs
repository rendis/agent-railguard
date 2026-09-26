#!/usr/bin/env node
// Renders the README banner, light and dark, into docs/assets/. Both variants come from one
// definition: the loop the visual guide (docs/guide/index.html) animates, drawn here at rest.
// Usage: node scripts/docs/render-banner.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "docs", "assets");

const THEMES = {
  light: {
    bg: "#F6F4EF", frame: "#DCD6CA", surface: "#FFFFFF", ink: "#1A1D23", soft: "#676C75", line: "#DCD6CA",
    flow: "#2F5BEA", guard: "#E0531F", warn: "#C98A0E", fix: "#6D4FD8", pass: "#23905A",
  },
  dark: {
    bg: "#101319", frame: "#2E3440", surface: "#181C24", ink: "#E8E6E1", soft: "#9AA0AB", line: "#2E3440",
    flow: "#7C98FF", guard: "#FF7A45", warn: "#F2B84B", fix: "#A994FF", pass: "#55C48C",
  },
};

const SANS = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const ICON = {
  task: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  agent: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  act: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  rg: '<path d="M12 3l8 3v6c0 4.7-3.4 8-8 9-4.6-1-8-4.3-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  fb: '<path d="M4 5h16v11h-9l-4 4v-4H4z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
  fix: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.8 2.8L16 9.5"/>',
};
const NODES = {
  task: { at: [54, 92], label: "Your task", color: "flow" },
  agent: { at: [187, 92], label: "Agent", color: "flow" },
  act: { at: [320, 92], label: "Action", color: "flow" },
  rg: { at: [453, 92], label: "Railguard", color: "guard" },
  ok: { at: [620, 92], label: "Verified", color: "pass" },
  fb: { at: [453, 262], label: "Feedback", color: "warn" },
  fix: { at: [320, 262], label: "Fix", color: "fix" },
};
const EDGES = [
  ["task", "agent", "flow"], ["agent", "act", "flow"], ["act", "rg", "flow"],
  ["rg", "ok", "pass", "passes"], ["rg", "fb", "warn", "fails"], ["fb", "fix", "fix"], ["fix", "act", "fix"],
];
const R = 42;

function loop(t) {
  const parts = [];
  for (const [a, b, color, label] of EDGES) {
    const [ax, ay] = NODES[a].at;
    const [bx, by] = NODES[b].at;
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const [x1, y1, x2, y2] = [ax + ux * (R + 7), ay + uy * (R + 7), bx - ux * (R + 9), by - uy * (R + 9)];
    const dash = color === "pass" ? ' stroke-dasharray="2 7"' : "";
    parts.push(`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${t[color]}" stroke-width="3" stroke-linecap="round"${dash} marker-end="url(#a-${color})"/>`);
    if (label) {
      const vertical = Math.abs(uy) > 0.5;
      const x = (ax + bx) / 2 + (vertical ? 12 : 0);
      const y = (ay + by) / 2 - (vertical ? 0 : 12);
      parts.push(`<text x="${x}" y="${y}" fill="${t[color]}" font-family="${MONO}" font-size="11" font-weight="600" letter-spacing=".9" text-anchor="${vertical ? "start" : "middle"}" dominant-baseline="middle">${label.toUpperCase()}</text>`);
    }
  }
  for (const [key, node] of Object.entries(NODES)) {
    const [x, y] = node.at;
    const c = t[node.color];
    if (key === "rg") parts.push(`<circle cx="${x}" cy="${y}" r="${R + 8}" fill="${c}" fill-opacity=".14"/>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="${R}" fill="${t.surface}" stroke="${c}" stroke-width="${key === "rg" ? 3.5 : 2.5}"/>`);
    parts.push(`<g transform="translate(${x - 13.4} ${y - 23.4}) scale(1.12)" fill="none" stroke="${c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[key]}</g>`);
    parts.push(`<text x="${x}" y="${y + 21}" fill="${t.ink}" font-family="${SANS}" font-size="13" font-weight="700" text-anchor="middle">${node.label}</text>`);
  }
  const markers = ["flow", "warn", "fix", "pass"].map((c) =>
    `<marker id="a-${c}" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1L8 5L1 9" fill="none" stroke="${t[c]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></marker>`,
  );
  return { defs: markers.join(""), body: parts.join("") };
}

function banner(t) {
  const { defs, body } = loop(t);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 400" width="960" height="400" role="img" aria-labelledby="title desc">`,
    `<title id="title">Railguard</title>`,
    `<desc id="desc">The agent proposes, Railguard checks. Your task goes to the agent, the agent acts and Railguard checks the action: if it fails, the reason goes back as feedback and the agent fixes it; if it passes, the change is verified.</desc>`,
    `<defs>${defs}</defs>`,
    `<rect x="1" y="1" width="958" height="398" rx="20" fill="${t.bg}" stroke="${t.frame}" stroke-width="2"/>`,
    // Brand mark and name
    `<g transform="translate(48 44)"><rect x="2" y="12" width="24" height="4" rx="2" fill="${t.guard}"/><circle cx="8" cy="14" r="5" fill="${t.surface}" stroke="${t.ink}" stroke-width="3"/><circle cx="20" cy="14" r="5" fill="${t.ink}"/></g>`,
    `<text x="86" y="64" fill="${t.ink}" font-family="${SANS}" font-size="22" font-weight="700">Railguard</text>`,
    // Headline
    `<text fill="${t.ink}" font-family="${SANS}" font-size="34" font-weight="700" letter-spacing="-.5"><tspan x="48" y="164">The agent proposes.</tspan><tspan x="48" y="208">Railguard checks.</tspan></text>`,
    `<text fill="${t.soft}" font-family="${SANS}" font-size="17" font-weight="500"><tspan x="48" y="262">Skills and deterministic guardrails</tspan><tspan x="48" y="288">for Claude Code, Codex and Cursor.</tspan></text>`,
    `<text x="48" y="348" fill="${t.guard}" font-family="${MONO}" font-size="13" font-weight="600" letter-spacing="1.2">SKILLS TEACH · CHECKS DECIDE</text>`,
    // The loop, scaled into the right half
    `<g transform="translate(408 68) scale(.76)">${body}</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

mkdirSync(out, { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  const file = join(out, `banner-${name}.svg`);
  writeFileSync(file, banner(theme));
  console.log(`wrote ${file}`);
}
