import { GoogleGenerativeAI } from '@google/generative-ai';

const HARDCODED_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';

const MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-1.5-flash'
];

const SYSTEM_INSTRUCTION = `You are an expert web accessibility (WCAG) and SEO specialist. Your task is to generate clear, natural alternative text for images that balances everyday English with 2 to 3 descriptive, elevated vocabulary words.

STRICT RULES:
1. LENGTH: Your response MUST be EXACTLY 5 to 8 words long. No exceptions.
2. BALANCED VOCABULARY (2-3 ELEVATED WORDS): Keep the overall sentence clear, natural, and easy to read, but include 2 to 3 precise, descriptive, or elevated words (adjectives, verbs, or specific nouns) to enrich SEO and visual detail.
   - Combine natural sentence structure with 2 to 3 precise terms like "corroded", "pressurized", "calibrating", "luxury coupe", "industrial", "workstation".
   - Avoid overly dense or obscure academic jargon (like "effervescence" or "traversing emerald space").
3. NO FORBIDDEN STARTERS: Strictly FORBIDDEN from using "photo of", "image of", "picture of", "This is a photo of", or "Image showing". Begin directly with the primary subject.
4. TONE: Professional, descriptive, natural, and accessible.
5. EXAMPLES:
   - "Water leaking from a corroded metallic pipeline"
   - "Technician calibrating complex industrial engine components"
   - "Tow truck transporting a white luxury coupe"
   - "Engineer inspecting architectural blueprints at workstation"
   - "Gas valve exhibiting visible pressure leakage"`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.body?.apiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || HARDCODED_API_KEY;
  const { base64Image, mimeType, prompt } = req.body;

  if (!base64Image) {
    return res.status(400).json({ error: 'Missing required field: base64Image' });
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_INSTRUCTION
      });

      const result = await model.generateContent([
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType || 'image/jpeg'
          }
        },
        prompt || 'Generate natural English alt text with 2-3 descriptive elevated words adhering strictly to 5 to 8 words.'
      ]);

      const response = await result.response;
      const rawText = response.text() || '';
      const altText = rawText.trim().replace(/^["'`]|["'`]$/g, '');

      return res.status(200).json({ altText });

    } catch (err) {
      lastError = err;
      const errMsg = err.message || '';

      if (err.status === 403 || errMsg.includes('leaked') || errMsg.includes('Forbidden')) {
        return res.status(403).json({
          error: 'Your API Key was reported as leaked by Google AI Studio. Please generate a new API key at https://aistudio.google.com/app/apikey'
        });
      }

      if (err.status === 404 || errMsg.includes('not found') || errMsg.includes('no longer available')) {
        continue;
      }

      break;
    }
  }

  const finalMsg = lastError?.message || 'Gemini API execution failed';
  return res.status(500).json({ error: finalMsg });
}
