import { GoogleGenerativeAI } from '@google/generative-ai';

const HARDCODED_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';

const MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-1.5-flash'
];

const SYSTEM_INSTRUCTION = `You are an elite accessibility and SEO specialist. Your task is to generate descriptive, concise alternative text for images using ADVANCED, SOPHISTICATED ENGLISH vocabulary.

STRICT RULES:
1. LENGTH: Your response MUST be EXACTLY 5 to 8 words long. No exceptions.
2. ADVANCED VOCABULARY: Use rich, elegant, professional, and visually precise English. Avoid simplistic terms.
   - Replace "man/woman" with "executive", "artisan", "technician", "individual", "professional".
   - Replace "sitting/looking" with "positioned", "contemplating", "inspecting", "engaging".
   - Replace "background/wall" with "ambient setting", "architectural facade", "textured backdrop".
   - Replace "computer/laptop" with "workstation", "digital display", "computing device".
3. NO FORBIDDEN STARTERS: Strictly FORBIDDEN from using "photo of", "image of", "picture of", "This is a photo of", or "Image showing". Begin directly with the primary subject.
4. TONE: Objective, highly professional, SEO-optimized, and WCAG accessible.
5. EXAMPLES:
   - "Executive analyzing financial metrics on laptop display"
   - "Golden retriever traversing vibrant emerald meadow space"
   - "Architect inspecting structural blueprints at sunlit workstation"`;

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
        prompt || 'Generate advanced English alt text for this image adhering strictly to 5 to 8 words.'
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
