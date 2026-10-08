// Channel name → matching key. MUST stay identical to the apps (FreeEpg.kt / FreeEpg.cs):
// "|AR.MBC| MBC 1 HD", "AR: MBC 1 4K", "MBC.1.ae" and "MBC 1" all give "mbc1".

const numbers = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const idSuffix = /\.(ae|sa|eg|qa|kw|bh|om|lb|jo|iq|ma|dz|tn|ly|sy|ps|ye|sd|bein|uk|us|fr|tr)$/;
const pipes = /\|[^|]*\|/g;
const brackets = /[\[(][^\])]*[\])]/g;
const prefix = /^\s*[a-z]{2,4}\s*[:|]\s*/;
const noise = /\b(hd|fhd|uhd|sd|hq|4k|8k|hevc|h265|h264|1080p?|720p?|hdr|backup|raw|vip|digital|mono|tv|channel|live|ar|en|arabic)\b/g;
const harakat = /[ً-ْـ]/g;

export function key(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  s = s.replace(idSuffix, "");
  s = s.replace(pipes, " ");
  s = s.replace(brackets, " ");
  s = s.replace(/[_.-]/g, " ");
  s = s.replace(prefix, " ");
  s = s.replace(noise, " ");
  s = s.split(" ").map(w => numbers[w] ?? w).join(" ");
  s = s.replace(harakat, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/قناه/g, "");
  return [...s].filter(c => /[\p{L}\p{N}]/u.test(c)).join("");
}

/** The key without vowels: catches spelling variants (Mubasher / Mobasher, Arabia / Arabiya). */
export const skeleton = k => k.replace(/[aeiouy]/g, "");
