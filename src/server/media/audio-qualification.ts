import { DomainError } from "@/domain/primitives";
import { audioEngine, type AudioEngine } from "./audio-processing";

/** Actual measured binary; another deployment platform needs its own qualification. */
const qualified = [{ package: "ffmpeg-static", packageVersion: "5.3.0", version: "6.0", binaryHash: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584", platform: "darwin/arm64" }] as const;
export async function qualifiedAudioEngine(): Promise<AudioEngine> {
  const engine = await audioEngine();
  if (!qualified.some(item => item.package === engine.package && item.packageVersion === engine.packageVersion && item.version === engine.version && item.binaryHash === engine.binaryHash && item.platform === engine.platform)) throw new DomainError("AUDIO_HOST_QUALIFICATION_REQUIRED", "This host's audio engine still needs its measured qualification before narration production. Existing recordings and their original reports remain available.", 503, false);
  return engine;
}
