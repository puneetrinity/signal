import { generateObject } from 'ai';

export type GenerateObjectModel = Parameters<typeof generateObject>[0]['model'];

type GroqFactory = (options: { apiKey: string }) => (modelName: string) => GenerateObjectModel;

function isGroqModule(mod: unknown): mod is { createGroq: GroqFactory } {
  if (!mod || typeof mod !== 'object') return false;
  const candidate = mod as { createGroq?: unknown };
  return typeof candidate.createGroq === 'function';
}

const DEFAULT_GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
let groqFactoryPromise: Promise<GroqFactory> | null = null;

async function getGroqFactory(): Promise<GroqFactory> {
  if (!groqFactoryPromise) {
    groqFactoryPromise = (async () => {
      const moduleName = '@ai-sdk/groq';
      const groqSdkModule = await import(/* webpackIgnore: true */ moduleName);
      if (!isGroqModule(groqSdkModule)) {
        throw new Error('Invalid @ai-sdk/groq module shape');
      }
      return groqSdkModule.createGroq;
    })();
  }
  return groqFactoryPromise;
}

/**
 * Dynamically load and create a Groq model.
 * Keeps @ai-sdk/groq as a runtime-only dependency.
 *
 * @param apiKey - Groq API key
 * @param modelOverride - Optional model name override (defaults to GROQ_MODEL env or built-in default)
 */
export async function createGroqModel(
  apiKey: string,
  modelOverride?: string,
): Promise<{ model: GenerateObjectModel; modelName: string }> {
  const createGroq = await getGroqFactory();
  const groq = createGroq({ apiKey });
  const modelName = modelOverride || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  return { model: groq(modelName), modelName };
}
