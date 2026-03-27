import { Router } from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { PDFParse } from 'pdf-parse';

const router = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '').toLowerCase();
    const isImage = type.startsWith('image/');
    const isPdf = type === 'application/pdf';
    const isText = type === 'text/plain';
    if (isImage || isPdf || isText) return cb(null, true);
    return cb(new Error('Only image, PDF, or text files are allowed'), false);
  }
});

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function isLikelyImage(file) {
  const type = (file?.mimetype || '').toLowerCase();
  return type.startsWith('image/');
}

function isLikelyPdf(file) {
  const type = (file?.mimetype || '').toLowerCase();
  return type === 'application/pdf' || (file?.originalname || '').toLowerCase().endsWith('.pdf');
}

function bufferToDataUrl(file) {
  const mime = (file?.mimetype || 'image/png').toLowerCase();
  const base64 = file.buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

async function extractImageTextWithVision(file) {
  const imageDataUrl = bufferToDataUrl(file);
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'You extract text from print documents. Return plain text only. Preserve key structure and labels.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extract all text and specifications from this document. Keep line breaks and section labels where possible. Return plain text only.'
          },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl,
              detail: 'high'
            }
          }
        ]
      }
    ],
    temperature: 0
  });
  return normalizeText(completion?.choices?.[0]?.message?.content);
}

async function compareInputsWithAI(clientText, jobCardText, internalJobCardJson) {
  const hasJson = internalJobCardJson && typeof internalJobCardJson === 'object';
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: [
          'You compare client requirements against an internal job card.',
          'Return strict JSON only.',
          'Treat semantically equivalent values as matching (e.g., 5k and 5000).',
          'Each and every detail in the client text must be present in the internal job card.',
          'numbers should match exactly, no tolerance for slight variations.',
          'for text field the meaning of the text should be the same, no tolerance for slight variations.',
          'in client text there can be details of multiple jobs, so you need to compare the job details with text that came from searched internal job card only, not from other jobs. you understad which job to compare by job umber/jobtitle/PO No, if not able to understand, then compare all jobs details with client text.',
          'dont compare pricings, only compare the job details.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          clientText,
          jobCardText: hasJson ? undefined : jobCardText,
          internalJobCardJson: hasJson ? internalJobCardJson : undefined,
          instruction: 'Identify which client-required details are present, missing, or contradictory in the internal job card. Internal data may be provided as structured JSON.'
        })
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'job_card_comparison',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            present: {
              type: 'array',
              items: { type: 'string' }
            },
            missing: {
              type: 'array',
              items: { type: 'string' }
            },
            discrepancies: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  client: { type: 'string' },
                  jobCard: { type: 'string' },
                  note: { type: 'string' }
                },
                required: ['client', 'jobCard', 'note']
              }
            },
            summary: { type: 'string' }
          },
          required: ['present', 'missing', 'discrepancies', 'summary']
        }
      }
    },
    temperature: 0
  });

  const raw = completion?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(raw);
}

router.post('/job-card-compare/extract', upload.single('file'), async (req, res) => {
  try {
    const textFromBody = normalizeText(req.body?.text);
    if (textFromBody) {
      return res.json({ text: textFromBody, source: 'text' });
    }

    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'Provide text or upload a file.' });
    }

    if (isLikelyImage(file)) {
      const text = await extractImageTextWithVision(file);
      return res.json({ text, source: 'image' });
    }

    if (isLikelyPdf(file)) {
      const parser = new PDFParse({ data: file.buffer });
      const parsed = await parser.getText();
      if (typeof parser.destroy === 'function') await parser.destroy();
      const text = normalizeText(parsed?.text);
      return res.json({ text, source: 'pdf', pages: parsed?.numpages || null });
    }

    const text = normalizeText(file.buffer.toString('utf8'));
    return res.json({ text, source: 'text-file' });
  } catch (error) {
    console.error('[job-card-compare] extract failed:', error);
    return res.status(500).json({ error: error?.message || 'Extraction failed' });
  }
});

router.post('/job-card-compare/compare', async (req, res) => {
  try {
    const clientText = normalizeText(req.body?.clientText);
    const jobCardText = normalizeText(req.body?.jobCardText);
    const internalJobCardJson = req.body?.internalJobCardJson;
    if (!clientText || (!jobCardText && !internalJobCardJson)) {
      return res.status(400).json({ error: 'clientText and either jobCardText or internalJobCardJson are required.' });
    }
    const result = await compareInputsWithAI(clientText, jobCardText, internalJobCardJson);
    return res.json(result);
  } catch (error) {
    console.error('[job-card-compare] compare failed:', error);
    return res.status(500).json({ error: error?.message || 'Comparison failed' });
  }
});

export default router;
