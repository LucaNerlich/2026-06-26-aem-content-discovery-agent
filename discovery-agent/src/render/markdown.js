function fmtScore(n) {
  return Number(n).toFixed(3);
}

function fragLink(id) {
  return `[\`${id}\`](#${id})`;
}

function renderMatches(matches) {
  const lines = ["## Top 3 Matching Content Fragments", ""];
  if (!matches || matches.length === 0) {
    lines.push("_No matching fragments returned._", "");
    return lines.join("\n");
  }
  lines.push("| # | id | path | score | reason |");
  lines.push("|---|----|------|-------|--------|");
  matches.forEach((m, i) => {
    const idCell = `<a id="${m.id}"></a>\`${m.id}\``;
    lines.push(`| ${i + 1} | ${idCell} | \`${m.path}\` | ${fmtScore(m.score)} | ${m.reason} |`);
  });
  lines.push("");
  return lines.join("\n");
}

function renderGapGroup(label, group, lines) {
  if (group.length === 0) return;
  lines.push(`### Coverage: ${label}`, "");
  for (const g of group) {
    lines.push(`#### ${g.topic}`);
    lines.push(g.description);
    if (g.partialMatches && g.partialMatches.length > 0) {
      lines.push(`- Partial matches: ${g.partialMatches.map(fragLink).join(", ")}`);
    }
    lines.push(`- Suggested action: ${g.suggestedAction}`);
    lines.push("");
  }
}

function renderGaps(gaps) {
  const lines = ["## Gap Analysis", ""];
  if (!gaps || gaps.length === 0) {
    lines.push("_No gaps identified._", "");
    return lines.join("\n");
  }
  const none = gaps.filter((g) => g.coverage === "none");
  const partial = gaps.filter((g) => g.coverage === "partial");
  renderGapGroup("none", none, lines);
  renderGapGroup("partial", partial, lines);
  return lines.join("\n");
}

function renderOutline(draft) {
  const lines = ["## Draft Outline", ""];
  lines.push(`**Title:** ${draft.title}`);
  lines.push(`**Path hint:** \`${draft.pathHint}\``);
  lines.push("");
  draft.sections.forEach((s, i) => {
    if (s.kind === "reuse") {
      const ids = s.fragmentIds.map(fragLink).join(", ");
      lines.push(`${i + 1}. **${s.heading}**`);
      lines.push(`   - Reuse: ${ids}`);
      lines.push(`   - Rationale: ${s.rationale}`);
    } else {
      lines.push(`${i + 1}. **${s.heading}** **NEW**`);
      lines.push(`   - Rationale: ${s.rationale}`);
      lines.push(`   - Sourcing hint: ${s.sourcingHint}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function renderReusedFragments(reusedFragments) {
  if (!reusedFragments || reusedFragments.length === 0) return "";
  const lines = ["## Reused Fragments", ""];
  reusedFragments.forEach((f) => {
    lines.push(`### \`${f.id}\` - ${f.title}`);
    lines.push(`<a id="appendix-${f.id}"></a>`);
    if (f.path) lines.push(`- Path: \`${f.path}\``);
    lines.push(`- Category: ${f.category}`);
    lines.push(`- Locale: ${f.locale}`);
    lines.push(`- Brand guidelines: ${f.brandGuidelinesApplied.join(", ")}`);
    lines.push(`- Last modified: ${f.lastModified}`);
    lines.push("");
    lines.push(f.content);
    lines.push("");
  });
  return lines.join("\n");
}

export function render(agentOutput) {
  if (!agentOutput || typeof agentOutput !== "object") {
    throw new TypeError("render(agentOutput) requires an AgentOutput object");
  }
  const parts = [
    renderMatches(agentOutput.matchedFragments),
    renderGaps(agentOutput.gaps),
    renderOutline(agentOutput.draftOutline),
  ];
  const appendix = renderReusedFragments(agentOutput.reusedFragments);
  if (appendix) parts.push(appendix);
  return parts.join("\n");
}
