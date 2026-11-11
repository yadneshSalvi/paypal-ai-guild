import { z } from "zod";
import { digest, DomainError } from "./primitives";
import { webAuditPolicy, webDesignSchema } from "./web-exhibition";
import type { WebAuditRequest } from "./web-audits";

const rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);
const token = z.enum(["paper", "ink", "mutedInk", "dark", "darkInk", "accent", "accentInk"]);
export const webPaletteMeasurementSchema = z.object({
  version: z.literal("guild.opaque-palette-contrast.v1"), sourceDigest: z.string(), designDigest: z.string(), rendererDigest: z.string(),
  locale: z.string(), viewport: z.object({ width: z.number().int(), height: z.number().int() }).strict(), observedAt: z.string().datetime(), design: webDesignSchema,
  css: z.object({ paper: z.string().max(3000), ink: z.string().max(3000), mutedInk: z.string().max(3000), dark: z.string().max(3000), darkInk: z.string().max(3000), accent: z.string().max(3000), accentInk: z.string().max(3000) }).strict(),
  readerContrast: z.enum(["true", "false"]).nullable(), opaque: z.boolean(), sourceBound: z.boolean(), passes: z.boolean(),
  pairs: z.array(z.object({ id: z.string(), foreground: token, background: token, foregroundRgb: rgb.nullable(), backgroundRgb: rgb.nullable(), ratio: z.number().finite().min(1).max(21).nullable(), minimumRatio: z.literal(4.5), passes: z.boolean() }).strict()).length(4),
}).strict();
export type WebPaletteMeasurement = z.infer<typeof webPaletteMeasurementSchema>;
export function wcagSrgbContrast(first: number[], second: number[]) {
  const luminance = (value: number[]) => value.map(component => component / 255).map(component => component <= .04045 ? component / 12.92 : ((component + .055) / 1.055) ** 2.4)
    .reduce((sum, component, index) => sum + component * [.2126, .7152, .0722][index]!, 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
/** Independently rederive the saved measurements before using their flags. */
export function validateWebPaletteMeasurement(request: WebAuditRequest, raw: unknown): WebPaletteMeasurement {
  const value = webPaletteMeasurementSchema.parse(raw), policy = webAuditPolicy.paletteContrast;
  const decode = (text: string): [number, number, number] | null => /^#[a-f0-9]{6}$/i.test(text) ? [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)] : null;
  const opaque = Object.values(value.css).every(color => decode(color) !== null);
  const sourceBound = value.readerContrast === "false" && Object.entries(value.css).every(([key, color]) => color.toLowerCase() === value.design.palette[key as keyof typeof value.css].toLowerCase());
  const pairs = policy.pairs.map(pair => {
    const foreground = decode(value.css[pair.foreground]), background = decode(value.css[pair.background]), ratio = foreground && background ? wcagSrgbContrast(foreground, background) : null;
    return { ...pair, foregroundRgb: foreground, backgroundRgb: background, ratio, minimumRatio: policy.minimumRatio, passes: ratio !== null && ratio >= policy.minimumRatio };
  });
  if (value.sourceDigest !== request.sourceDigest || value.designDigest !== request.designDigest || digest(value.design) !== request.designDigest || value.rendererDigest !== request.rendererDigest || value.locale !== request.locale || digest(value.viewport) !== digest(request.viewport)
    || value.opaque !== opaque || value.sourceBound !== sourceBound || value.passes !== (opaque && sourceBound && pairs.every(pair => pair.passes)) || digest(pairs) !== digest(value.pairs))
    throw new DomainError("WEB_PALETTE_CONTRAST_BINDING", "The original opaque palette, source binding, measured ratios or unrounded contrast gate changed. Native axe findings remain separate.", 422, false);
  return value;
}
