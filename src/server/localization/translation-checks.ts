import { francAll } from "franc";
import type { AcceptancePack, ArtifactManifest, Locale, WorkPackage } from "@/contracts/guild";
import { locales } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { researchTranslationSource, scriptMeasurement, translationAcceptancePack, translationArtifactSchema, translationGlossary, translationLocales, translationStandard, translationTextChecks, type TranslationText } from "@/domain/translation";

export interface LanguageFinding { locale: Locale; key: string; expected: string; detected: string; sufficient: boolean; letters: number; passed: boolean; ranking: { language: string; relativeScore: number }[] }
export function identifyTranslationLanguages(translations: Partial<Record<Locale, TranslationText>>, keys: string[]): LanguageFinding[] {
  return locales.flatMap(locale => keys.map(key => {
    const text = translations[locale]?.[key]?.body ?? "", letters = scriptMeasurement(text, locale).letters;
    const sufficient = letters >= translationStandard.languageId.minimumLetters;
    // No target-language hint or candidate allowlist is given to the detector.
    const ranking = sufficient ? francAll(text, { minLength: translationStandard.languageId.minimumLetters }).slice(0, 3).map(([language, relativeScore]) => ({ language, relativeScore })) : [];
    const detected = ranking[0]?.language ?? "und", expected = translationLocales[locale].iso6393;
    return { locale, key, expected, detected, sufficient, letters, passed: sufficient && detected === expected, ranking };
  }));
}

export function initialTranslationChecks(pkg: WorkPackage, artifact: ArtifactManifest, source: ArtifactManifest): { pack: AcceptancePack; report: { schemaVersion: string; artifactId: string; artifactHash: string; sourceArtifactHash: string; staticChecks: ReturnType<typeof translationTextChecks> | null; language: LanguageFinding[]; calibration: typeof translationStandard.calibration } } {
  const pack = translationAcceptancePack(source), parsed = translationArtifactSchema.safeParse(artifact.content), english = researchTranslationSource(source);
  const report = { schemaVersion: "guild.translation-verification.v2", artifactId: artifact.id, artifactHash: artifact.contentHash, sourceArtifactHash: source.contentHash, staticChecks: parsed.success ? translationTextChecks(parsed.data.translations, english, parsed.data.localeMetadata) : null, language: [] as LanguageFinding[], calibration: translationStandard.calibration };
  const common = parsed.success && digest(artifact.content) === artifact.contentHash && pkg.acceptancePack.digest === pack.digest && parsed.data.contractDigest === pack.digest && parsed.data.glossaryDigest === digest(translationGlossary);
  const checks = report.staticChecks;
  if (parsed.success) report.language = identifyTranslationLanguages(parsed.data.translations, Object.keys(english));
  const failures = <T>(items: T[], describe: (item: T) => string) => items.slice(0, 25).map(describe).join("; ") + (items.length > 25 ? `; and ${items.length - 25} further findings` : "");
  for (const criterion of pack.criteria) {
    if (criterion.kind === "human") { criterion.status = "review"; criterion.evidence = translationStandard.humanReview; continue; }
    if (criterion.kind === "advisory") { criterion.status = "review"; criterion.evidence = "Independent back-translation has not yet completed. This advisory is not a blocking semantic verdict."; continue; }
    let passed = false, evidence = "The submission does not match the agreed artifact schema, source, glossary or acceptance pack.";
    if (common && parsed.success && checks) switch (criterion.id) {
      case "source": passed = checks.exactEnglish && parsed.data.sourceArtifactId === source.id && parsed.data.sourceArtifactHash === source.contentHash && parsed.data.inputBindings.some(item => item.artifactId === source.id && item.artifactHash === source.contentHash); evidence = passed ? "Every English title and body is byte-for-byte equal to the agreed research labels; exact source artifact and input lineage are retained." : "English text or the source-artifact binding differs from the agreed research."; break;
      case "keys": passed = checks.keys; evidence = passed ? `${Object.keys(english).length} exact title/body label pairs in each of all six locales; no extra, missing or empty required entries.` : "At least one locale has extra, missing or invalid required label entries."; break;
      case "placeholders": passed = checks.keys && checks.placeholders.length === 0; evidence = passed ? "Every agreed text field was scanned for the frozen unresolved-placeholder patterns and copied English bodies. Mixed-language nuance still needs review." : failures(checks.placeholders, item => `${item.locale}/${item.key}: ${item.reason}`) || "Required text is missing."; break;
      case "glossary": passed = checks.keys && checks.glossary.length === 0; evidence = passed ? "Every protected archival name used by the source appears in the corresponding translated label, under the agreed glossary." : failures(checks.glossary, item => `${item.locale}/${item.key}: missing ${item.term}`) || "Required text is missing."; break;
      case "script": passed = checks.keys && checks.metadataMatches && checks.scripts.every(item => item.passed); evidence = passed ? "All six locale/script/direction records match the contract, every text meets its script fraction, and no embedded bidi override was found." : `${checks.metadataMatches ? "" : "Locale/script/direction metadata changed. "}${failures(checks.scripts.filter(item => !item.passed), item => `${item.locale}/${item.key}: script fraction ${item.fraction.toFixed(3)}`)}`; break;
      case "language": passed = checks.keys && report.language.every(item => item.passed); evidence = passed ? `franc 6.2.0 independently identified all ${report.language.length} sufficiently long bodies with the expected language ranked first. Relative scores are not probabilities or meaning checks.` : failures(report.language.filter(item => !item.passed), item => `${item.locale}/${item.key}: ${item.sufficient ? `expected ${item.expected}, detected ${item.detected}` : `only ${item.letters} letters; insufficient sample`}`); break;
    }
    criterion.status = passed ? "passed" : "failed"; criterion.evidence = evidence;
  }
  return { pack, report };
}
