/**
 * Deterministic truth check for a tailored resume: no model calls.
 * Flags what a tailoring run most often gets wrong:
 *  - numbers that aren't in the owner's sources,
 *  - technology terms borrowed from the JD that the owner never claimed,
 *  - anything on the owner's do-not-claim list.
 * It can't judge a true fact attached to the wrong project; CLAUDE.md rules and review cover that.
 */

export interface TruthCheck {
  ok: boolean;
  unknownNumbers: string[];
  borrowedTerms: string[];
  forbidden: string[];
}

/** Spellings that mean the same thing as something the owner already claims. */
const ALIASES: Record<string, string> = {
  restful: "rest",
  "react.js": "react",
  reactjs: "react",
  "node.js": "node",
  golang: "go",
  "ci/cd": "cicd",
  "c#": "c#",
  nosql: "nosql",
};

export function texToText(tex: string): string {
  return tex
    .replace(/^[\s\S]*?\\begin\{document\}/, "")
    .replace(/\\end\{document\}[\s\S]*$/, "")
    .replace(/\\href\{[^}]*\}/g, "")
    .replace(/\$\\times\$/g, "×")
    .replace(/\\(textbf|textit|textnormal|mbox|section|entry|item|emph|underline)\b/g, " ")
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, " ")
    .replace(/\\([#%&$_])/g, "$1")
    .replace(/[{}~]/g, " ")
    .replace(/--/g, "–");
}

export const norm = (t: string) => {
  const l = t.toLowerCase().replace(/[.,;:)(]+$/g, "").replace(/^[(]+/, "");
  const a = ALIASES[l] ?? l;
  return a.length > 3 && a.endsWith("s") && !a.endsWith("ss") ? a.slice(0, -1) : a;
};

/** Tokens that look like technologies: acronyms, CamelCase, dotted/symbol names, or capitalised mid-sentence words. */
export function techTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<=^|[\s,(/|–—-])([A-Za-z][A-Za-z0-9.+#/-]*[A-Za-z0-9+#])/g)) {
    const t = m[1];
    const prev = text.slice(Math.max(0, m.index! - 2), m.index!);
    const sentenceStart = /^$|[.!?:•]\s*$|\n\s*$/.test(prev);
    const looksTech = /[A-Z].*[A-Z]|[.#+/]|\d/.test(t) || (/^[A-Z]/.test(t) && !sentenceStart);
    if (looksTech) out.add(norm(t));
  }
  return out;
}

function numbers(text: string): Set<string> {
  return new Set([...text.matchAll(/\d[\d,.]*\s*(?:%|\+|K\+?|×|x\b|ms)?/g)].map((m) => m[0].replace(/\s+/g, "").replace(/,/g, "").replace(/\.$/, "")));
}

export function truthCheck(input: { tailoredTex: string; baseTex: string; factsText: string; jdText: string; forbiddenTerms: string[] }): TruthCheck {
  const out = texToText(input.tailoredTex);
  const sources = `${texToText(input.baseTex)}\n${input.factsText}`;

  // Exact match including qualifiers: "10,000+" is a different claim from "10,000".
  const known = numbers(sources);
  const unknownNumbers = [...numbers(out)].filter((n) => !known.has(n));

  const sourceTerms = new Set([...techTokens(sources), ...[...sources.toLowerCase().matchAll(/[a-z0-9.#+/-]+/g)].map((m) => norm(m[0]))]);
  const jdTerms = techTokens(input.jdText);
  const borrowedTerms = [...techTokens(out)].filter((t) => jdTerms.has(t) && !sourceTerms.has(t));

  const lower = out.toLowerCase();
  const forbidden = input.forbiddenTerms.filter((term) =>
    new RegExp(`(^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(lower),
  );

  return {
    ok: !unknownNumbers.length && !borrowedTerms.length && !forbidden.length,
    unknownNumbers,
    borrowedTerms,
    forbidden,
  };
}
