const c = (n: string) => (s: string | number) => `\x1b[${n}m${s}\x1b[0m`;
export const bold = c('1'), dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), mag = c('35');

// Horizontal gradient across a string (teal -> violet).
export function gradient(text: string, from = [0, 220, 190], to = [150, 90, 255]) {
  const chars = [...text];
  return chars.map((ch, i) => {
    const t = chars.length < 2 ? 0 : i / (chars.length - 1);
    const [r, g, b] = from.map((f, k) => Math.round(f + (to[k] - f) * t));
    return `\x1b[38;2;${r};${g};${b}m${ch}`;
  }).join('') + '\x1b[0m';
}

export const BANNER = [
  ' ████████╗ █████╗ ██╗██╗      ██████╗  █████╗ ████████╗███████╗',
  ' ╚══██╔══╝██╔══██╗██║██║     ██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝',
  '    ██║   ███████║██║██║     ██║  ███╗███████║   ██║   █████╗  ',
  '    ██║   ██╔══██║██║██║     ██║   ██║██╔══██║   ██║   ██╔══╝  ',
  '    ██║   ██║  ██║██║███████╗╚██████╔╝██║  ██║   ██║   ███████╗',
  '    ╚═╝   ╚═╝  ╚═╝╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝',
];

export function banner() {
  const art = BANNER.map((l) => gradient(l)).join('\n');
  return `${art}\n ${dim('skills & plugins manager for Claude Code · built to save tokens')}\n`;
}

export function bar(score: number, width = 10) {
  const n = Math.round((score / 100) * width);
  const col = score >= 75 ? green : score >= 55 ? yellow : red;
  return col('█'.repeat(n)) + dim('░'.repeat(width - n));
}

export const stars = (n: number) => yellow('★ ') + (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
