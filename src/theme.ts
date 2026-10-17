// Tailgate look: plain text, one signal colour (safety orange), everything else is weight and dimming.
const c = (n: string) => (s: string | number) => `\x1b[${n}m${s}\x1b[0m`;
export const bold = c('1'), dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), mag = c('35');
export const rgb = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;

export const accent = rgb(232, 89, 12);
// Orange block with dark text, used once per screen as the title tag.
export const tag = (s: string) => `\x1b[48;2;232;89;12m\x1b[30m ${s} \x1b[0m`;

export function banner(version: string) {
  return `\n ${accent('■')} ${bold('tailgate')} ${dim('v' + version)}\n ${dim('skills, plugins and tools for Claude Code')}\n`;
}

export function compactNum(n: number) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}

// Fixed-width so columns line up. Empty for curated tools that have no star count.
export const starsCol = (n: number) => (n > 0 ? compactNum(n).padStart(6) : ' '.repeat(6));

// Quality grade, plain letter. S and A are good, B is acceptable.
export const grade = (t: string) => (t === 'S' ? accent(t) : t === 'A' ? t : dim(t));

export const scanWord = (level?: string) =>
  level === 'risky' ? red('risky  ') : level === 'notes' ? yellow('notes  ') : level === 'clean' ? green('clean  ') : dim('unscanned');
