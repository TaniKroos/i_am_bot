import { norm, techTokens, texToText } from "./truthcheck.js";

/**
 * How much a resume under-sells the owner for a JD, without any model call.
 * Keywords = JD technology terms the owner can truthfully claim (present in base resume or facts).
 * Each keyword scores 2 when it's prominent (summary, first two experience bullets, first skills row),
 * 1 when it's elsewhere, 0 when absent. gap = 1 - score / (2 × keywords).
 */
export interface Gap {
  gap: number;
  keywords: string[];
  buried: string[];
  missing: string[];
}

function regions(tex: string): { prominent: string; rest: string } {
  const body = tex.replace(/^[\s\S]*?\\begin\{document\}/, "");
  const section = (name: RegExp) => {
    const m = body.match(new RegExp(`\\\\section\\{${name.source}\\}([\\s\\S]*?)(?=\\\\section\\{|\\\\end\\{document\\})`, "i"));
    return m?.[1] ?? "";
  };
  const summary = section(/[^}]*Summary/);
  const experience = section(/[^}]*Experience/);
  const skills = section(/[^}]*Skills/);
  const firstBullets = experience.split("\\item").slice(1, 3).join(" ");
  const firstSkillRow = skills.split("\\item").slice(1, 2).join(" ");
  const prominent = texToText(`\\begin{document}${summary} ${firstBullets} ${firstSkillRow}\\end{document}`);
  return { prominent, rest: texToText(tex) };
}

const tokensOf = (text: string) => new Set([...techTokens(text), ...[...text.toLowerCase().matchAll(/[a-z0-9.#+/-]+/g)].map((m) => norm(m[0]))]);

/**
 * The owner's technology vocabulary: the base resume's Technical Skills section, the profile's skill lists
 * and approved wording, minus anything on the do-not-list. Generic words ("engineer", "year") never count.
 */
export function ownerVocabulary(baseTex: string, profile: { targeting: any; facts: any }): Set<string> {
  const skillsSection = baseTex.match(/\\section\{[^}]*Skills\}([\s\S]*?)(?=\\section\{|\\end\{document\})/i)?.[1] ?? "";
  const listed = [...(profile.targeting?.skills?.strong ?? []), ...(profile.targeting?.skills?.familiar ?? []), ...(profile.facts?.approved_terms ?? [])];
  const vocab = new Set([...tokensOf(texToText(`\\begin{document}${skillsSection}\\end{document}`)), ...listed.flatMap((s: string) => [...tokensOf(s)])]);
  for (const t of profile.facts?.do_not_list_terms ?? []) vocab.delete(norm(t));
  for (const generic of ["api", "tool", "language", "server", "service", "code", "engineering", "system", "application", "web", "data", "platform", "core", "label"]) vocab.delete(generic);
  // Drop LaTeX layout words and bare numbers that leak in from the skills section's markup.
  return new Set([...vocab].filter((t) => /^[a-z][a-z0-9.#+-]*[a-z0-9#+]$|^c#$|^\.net$/.test(t) && !/^(itemize|leftmargin|itemsep|textbf|item)$/.test(t)));
}

export function resumeGap(resumeTex: string, jdText: string, vocabulary: Set<string>): Gap {
  const keywords = [...new Set([...tokensOf(jdText)])].filter((k) => vocabulary.has(k) && k.length > 1);
  if (keywords.length < 5) return { gap: 0, keywords, buried: [], missing: [] };
  const { prominent, rest } = regions(resumeTex);
  const strong = tokensOf(prominent);
  const anywhere = tokensOf(rest);
  let score = 0;
  const buried: string[] = [];
  const missing: string[] = [];
  for (const k of keywords) {
    if (strong.has(k)) score += 2;
    else if (anywhere.has(k)) (score += 1), buried.push(k);
    else missing.push(k);
  }
  return { gap: 1 - score / (2 * keywords.length), keywords, buried, missing };
}
