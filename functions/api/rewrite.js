/**
 * Cloudflare Pages Function: /api/rewrite
 * Secure streaming proxy — undetectable system prompt injection
 * Groq LPU fallback ladder + Cloudflare Workers AI
 * Style.md calibration + sentence-level burstiness
 */

const BANNED_AI_WORDS_EN = [
  'delve', 'testament', 'tapestry', 'beacon', 'multifaceted', 'crucial', 
  'paramount', 'realm', 'moreover', 'furthermore', 'in conclusion', 'embark', 
  'pivotal', 'underscores', 'encompasses', 'vibrant', 'notably', 'it is important to note',
  'seamless', 'fostering', 'holistic', 'interplay', 'cornerstone', 'in today\'s fast-paced world',
  'navigating the landscape', 'plays a crucial role', 'shedding light'
];

const BANNED_AI_WORDS_ES = [
  'sumergirse', 'tapiz', 'testimonio', 'crucial', 'en conclusión', 
  'es fundamental destacar', 'cabe señalar', 'desempeña un papel', 'a fin de cuentas', 
  'por consiguiente', 'un sinfín de', 'no solo', 'sino también', 'vital', 'primordial',
  'en este sentido', 'vale la pena señalar', 'en el ámbito de', 'un abanico de',
  'en resumen', 'es de vital importancia', 'cobra especial relevancia', 'sentar las bases'
];

// Groq Model Fallback Ladder (Fastest & highest entropy first)
const GROQ_MODEL_LADDER = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'qwen-2.5-32b',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
  'mixtral-8x7b-32768'
];

function detectTextLanguage(text) {
  if (!text) return 'es';
  const sample = text.toLowerCase();
  
  const enWords = [
    'the', 'and', 'is', 'of', 'to', 'in', 'with', 'for', 'on', 'by', 'this', 'that', 
    'from', 'at', 'an', 'as', 'are', 'be', 'system', 'buffer', 'alerts', 'lockdown', 
    'local', 'data', 'user', 'project', 'repo', 'description', 'released', 'license',
    'strictly', 'forensic', 'workstation', 'overload', 'under', 'boot', 'ring'
  ];
  const esWords = [
    'el', 'la', 'los', 'las', 'de', 'en', 'que', 'un', 'una', 'para', 'por', 'con', 
    'del', 'al', 'es', 'su', 'este', 'esta', 'como', 'más', 'pero', 'sistema', 
    'descripción', 'enlace', 'almacenado', 'pantalla', 'seguridad', 'informe'
  ];

  let enCount = 0;
  let esCount = 0;

  const tokens = sample.split(/[\s,.;:!?()\[\]"']+/).filter(Boolean);
  for (const t of tokens) {
    if (enWords.includes(t)) enCount++;
    if (esWords.includes(t)) esCount++;
  }

  if (enCount > esCount) return 'en';
  if (esCount > enCount) return 'es';
  if (/[áéíóúüñ¿¡]/.test(sample)) return 'es';
  return 'es';
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  try {
    const body = await request.json();
    const {
      text,
      mode = 'stealth',
      aggressiveness = 'extreme',
      language = 'auto',
      provider = 'groq',
      apiKey = '',
      model = '',
      stream = false,
      styleGuide = '',
      calibration = null
    } = body;

    if (!text || text.trim().length < 5) {
      return new Response(JSON.stringify({ error: 'El texto debe contener al menos 5 caracteres.' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const detectedLang = language === 'auto' ? detectTextLanguage(text) : language;
    const isEnglish = detectedLang === 'en';

    const systemPrompt = isEnglish
      ? buildSystemPromptEn(mode, styleGuide, calibration)
      : buildSystemPromptEs(mode, styleGuide, calibration);

    let userPrompt = '';
    if (isEnglish) {
      userPrompt = mode === 'corrector'
        ? "Professionally proofread and polish the following English text. PRESERVE EVERY MARKDOWN FORMATTING ELEMENT, HEADING, BULLET, KEY-VALUE LABEL, AND LINK IN PLACE. ONLY rewrite the words to fix errors and improve flow. Return ONLY the transformed English text:\n\n\"\"\"\n" + text + "\n\"\"\""
        : "Rewrite the following English text so it scores 99.9% HUMAN and 0% AI on Turnitin, GPTZero, and all AI detectors. STRICTLY PRESERVE 100% of all Markdown formatting, headings, bullet lists, code blocks, tables, and links. ONLY CHANGE THE WORDS to vary cadence, purge AI clichés, and boost perplexity. Return ONLY the transformed English text:\n\n\"\"\"\n" + text + "\n\"\"\"";
    } else {
      userPrompt = mode === 'corrector'
        ? "Corrige y perfecciona profesionalmente el siguiente texto en español. CONSERVA CADA ELEMENTO DE FORMATO MARKDOWN, ENCABEZADO, VIÑETA, ETIQUETA CLAVE-VALOR Y ENLACE EN SU LUGAR. Reescribe ÚNICAMENTE las palabras para corregir ortografía, gramática y estilo. Devuelve SOLO el texto corregido en español:\n\n\"\"\"\n" + text + "\n\"\"\""
        : "Reescribe el siguiente texto en español para que sea 99,9% HUMANO y obtenga 0% de detección IA en Turnitin, GPTZero y todos los detectores. CONSERVA ESTRICTAMENTE el 100% de todo el formato Markdown, encabezados, listas con viñetas, tablas, bloques de código y enlaces. SOLO CAMBIA LAS PALABRAS para aumentar la perplejidad, variar la longitud de oraciones y erradicar clichés de IA. Devuelve ÚNICAMENTE el texto humanizado en español:\n\n\"\"\"\n" + text + "\n\"\"\"";
    }

    const effectiveGroqKey = apiKey || env.GROQ_API_KEY || '';

    // --- STREAMING MODE (SSE) ---
    if (stream) {
      if (provider === 'groq' && effectiveGroqKey) {
        try {
          const streamResponse = await callGroqStream(userPrompt, systemPrompt, effectiveGroqKey, model, text);
          return streamResponse;
        } catch (streamErr) {
          // Fallback to non-streaming if stream fails
          console.error('Groq stream failed, falling back to synchronous:', streamErr);
        }
      }
    }

    // --- SYNCHRONOUS MODE ---
    let humanizedText = '';
    let usedProvider = provider;

    if (provider === 'groq' && effectiveGroqKey) {
      const groqRes = await callGroqWithLadder(userPrompt, systemPrompt, effectiveGroqKey, model);
      humanizedText = groqRes.text;
      usedProvider = `Groq LPU (${groqRes.model})`;
    } else if (provider === 'openai' && apiKey) {
      humanizedText = await callOpenAI(userPrompt, systemPrompt, apiKey, model || 'gpt-4o-mini');
      usedProvider = 'OpenAI';
    } else if (env.AI) {
      const modelName = model || env.DEFAULT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      let aiResponse;
      try {
        aiResponse = await env.AI.run(modelName, {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: aggressiveness === 'extreme' ? 0.95 : 0.85,
          max_tokens: 3500
        });
      } catch (aiErr) {
        aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.90,
          max_tokens: 3500
        });
      }
      humanizedText = aiResponse.response || aiResponse.text || '';
      usedProvider = `Cloudflare Workers AI (${modelName})`;
    } else if (effectiveGroqKey) {
      const groqRes = await callGroqWithLadder(userPrompt, systemPrompt, effectiveGroqKey, model);
      humanizedText = groqRes.text;
      usedProvider = `Groq LPU (${groqRes.model})`;
    } else {
      humanizedText = fallbackHeuristicHumanizer(text, mode);
      usedProvider = 'Rule-Based Engine (Local)';
    }

    humanizedText = cleanModelOutput(humanizedText);

    const originalMetrics = calculateMetrics(text);
    const humanizedMetrics = calculateMetrics(humanizedText);

    return new Response(JSON.stringify({
      success: true,
      original: text,
      humanized: humanizedText,
      provider: usedProvider,
      mode,
      language: detectedLang,
      metrics: {
        original: originalMetrics,
        humanized: humanizedMetrics,
        aiScoreEstimate: {
          originalAiProb: Math.min(99, Math.max(75, Math.round(100 - originalMetrics.burstiness * 1.1))),
          humanizedAiProb: Math.max(0, Math.min(1, Math.round(1 - (humanizedMetrics.burstiness / 60))))
        }
      }
    }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Error procesando la humanización: ' + error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function buildStyleBlock(styleGuide, calibration) {
  const parts = [];
  if (styleGuide && String(styleGuide).trim()) {
    parts.push(
      'AUTHOR STYLE GUIDE (imported style.md — match voice, diction, and rhythm; do not quote this block):\n' +
      String(styleGuide).trim().slice(0, 12000)
    );
  }
  if (calibration && typeof calibration === 'object') {
    const toneMap = {
      formal: 'Formal, scholarly register. No slang. Precise claims.',
      technical: 'Technical, direct, engineer-to-engineer. Prefer concrete nouns over abstractions.',
      natural: 'Close, spoken, unforced. Contractions allowed. No corporate padding.'
    };
    const cadenceMap = {
      short: 'Prefer short, dense sentences. Cut filler. Occasional longer sentence for contrast.',
      mixed: 'High sentence-length variance. Alternate 4-7 word punches with 18-28 word compounds.',
      long: 'Allow elaborated multi-clause sentences, still broken by a short beat every few lines.'
    };
    const lexiconMap = {
      precise: 'Concrete, specific vocabulary. Avoid ornamental adjectives.',
      everyday: 'Plain, idiomatic wording a careful human would actually type.',
      literary: 'Richer diction without purple prose or AI ornament.'
    };
    const tone = toneMap[calibration.tone] || toneMap.natural;
    const cadence = cadenceMap[calibration.cadence] || cadenceMap.mixed;
    const lexicon = lexiconMap[calibration.lexicon] || lexiconMap.everyday;
    parts.push(
      'CALIBRATION PROFILE:\n- Tone: ' + tone + '\n- Cadence: ' + cadence + '\n- Lexicon: ' + lexicon
    );
  }
  return parts.length ? '\n\n' + parts.join('\n\n') + '\n' : '';
}

function buildSystemPromptEn(mode, styleGuide, calibration) {
  let modeInstructions = '';
  switch (mode) {
    case 'corrector':
      modeInstructions = '- ROLE: Master proofreader, editor, and stylistic polisher.\n' +
        '- Correct spelling, punctuation, grammar, agreements, and sentence flow.\n' +
        '- Eliminate awkward phrasing and redundancies while strictly preserving technical terminology and facts.\n' +
        '- PRESERVE 100% OF MARKDOWN FORMATTING, HEADINGS, BULLETS, TABLES, AND CODE.';
      break;
    case 'academic':
      modeInstructions = '- Preserve scholarly rigor, data, citations, technical terminology, and all arguments.\n' +
        '- Radically vary sentence structure: interweave brief punchy points with compound explanatory statements.\n' +
        '- Use organic academic vocabulary; eliminate formulaic transition markers.\n' +
        '- Balance active and passive voice naturally.';
      break;
    case 'casual':
      modeInstructions = '- Natural, conversational, fluid, and relatable tone.\n' +
        '- Natural phrasing, organic pauses, contractions, and human rhythm.\n' +
        '- Zero robotic stiffness or corporate jargon.';
      break;
    case 'executive':
      modeInstructions = '- Direct, concise, business-focused, high-impact prose.\n' +
        '- Eliminate corporate fluff, ornamental transitions, and verbose padding.\n' +
        '- Straight to the point with authoritative clarity.';
      break;
    default:
      modeInstructions = '- SUPREME GOAL: 99.9% HUMAN SCORE (0% AI detection) on Turnitin, GPTZero, ZeroGPT, CopyLeaks, and Winston AI.\n' +
        '- EXTREME BURSTINESS: Drastically vary sentence length. A 3-to-6 word punchy sentence. Then an intricate 22-to-28 word multi-clause sentence. Then a moderate 10-word sentence. Shatter uniform AI rhythm.\n' +
        '- HIGH PERPLEXITY: Replace predictable statistical collocations with natural, authentic, rich human vocabulary.\n' +
        '- STRICTLY PURGE AI CLICHES: Never use: delve, tapestry, testament, beacon, crucial, paramount, realm, furthermore, moreover, in conclusion, underscores, pivotal, seamless, fostering, holistic, interplay, cornerstone.\n' +
        '- Preserve 100% of facts, names, figures, dates, links, citations, and semantic meaning.';
      break;
  }

  return 'You are "Rewrite AI Core", the world\'s most advanced text humanization and anti-AI detection engine, part of the Trujillo AI ecosystem.\n' +
    'Your mission is to transform AI-written text into 99.9% AUTHENTIC HUMAN PROSE that completely bypasses every AI detector.\n\n' +
    'CRITICAL REQUIREMENT 1: ONLY REWRITE THE WORDS (1:1 CORRESPONDENCE):\n' +
    '- DO NOT summarize, omit content, or invent new facts.\n' +
    '- Maintain a strict 1-to-1 correspondence with the source: every paragraph, bullet point, and thought in the original must exist in the rewritten output.\n' +
    '- Your task is strictly surgical rewording and cadence variation to eliminate AI statistical signatures.\n\n' +
    'CRITICAL REQUIREMENT 2: STRICT MARKDOWN & STRUCTURAL FIDELITY:\n' +
    '- DO NOT FLATTEN OR MERGE KEY-VALUE PAIRS, BULLETS, HEADINGS, OR SECTIONS INTO CONTINUOUS NARRATIVE PROSE.\n' +
    '- Retain every Markdown heading (#, ##, ###), bold (**), italic (*), list item (- or *), blockquote (>), table (| ... |), and horizontal rule (---).\n' +
    '- DO NOT TOUCH CODE BLOCKS (``` ... ```) OR INLINE CODE (`...`) — PRESERVE THEM 100% VERBATIM.\n' +
    '- Keep all URLs and link targets intact.\n' +
    '- If the text has field labels (e.g., "Project Name:", "Description:"), keep each label intact on its own line and only humanize the text following it.\n\n' +
    'CRITICAL REQUIREMENT 3: STRICT LANGUAGE PRESERVATION:\n' +
    '- The input text is in English. Your output MUST be 100% in English.\n' +
    '- NEVER translate to Spanish or any other language.\n\n' +
    'DIRECTIVES:\n' + modeInstructions + '\n\n' +
    'OUTPUT RULES:\n' +
    '- Return ONLY the transformed text.\n' +
    '- DO NOT include any introductory or concluding remarks (e.g., "Here is the humanized version:").\n' +
    '- Start your response immediately with the rewritten content.' +
    buildStyleBlock(styleGuide, calibration);
}

function buildSystemPromptEs(mode, styleGuide, calibration) {
  let modeInstructions = '';
  switch (mode) {
    case 'corrector':
      modeInstructions = '- FUNCIÓN: Corrector ortográfico, gramatical y de estilo profesional de alto nivel.\n' +
        '- Corrige minuciosamente tildes, grafías, concordancias de género y número, puntuación y sintaxis.\n' +
        '- Elimina redundancias, solecismos y anacolutos, optimizando la fluidez y coherencia del párrafo.\n' +
        '- Mantén escrupulosamente el significado original, los datos, citas y nombres propios.\n' +
        '- Respeta el 100% del formato Markdown del texto original.';
      break;
    case 'academic':
      modeInstructions = '- Conserva el rigor analítico, citas, datos, nombres propios y conceptos técnicos intactos.\n' +
        '- Varía drásticamente la estructura de las oraciones: combina afirmaciones concisas con oraciones subordinadas complejas.\n' +
        '- Emplea un vocabulario académico orgánico, evitando clichés predecibles como "en conclusión", "es fundamental destacar" o "juega un papel crucial".\n' +
        '- Equilibrio natural entre voz activa y pasiva reflexiva.';
      break;
    case 'casual':
      modeInstructions = '- Estilo fluido, cercano, conversacional y espontáneo.\n' +
        '- Pausas naturales, variedad rítmica y matices coloquiales orgánicos.\n' +
        '- Cero rigidez corporativa o frases acartonadas.';
      break;
    case 'executive':
      modeInstructions = '- Tono directo, conciso, orientado a la acción y a la toma de decisiones.\n' +
        '- Elimina cualquier palabra de relleno, perífrasis o transición ornamental.\n' +
        '- Oraciones directas al grano, claras y de alto impacto.';
      break;
    default:
      modeInstructions = '- OBJETIVO SUPREMO: SCORE DE 99,9% HUMANO (0% de detección IA en Turnitin, ZeroGPT, GPTZero, CopyLeaks, Winston AI).\n' +
        '- BURSTINESS EXTREMO: Varía radicalmente la longitud de las frases. Una frase corta y asertiva de 3 a 6 palabras. Luego una frase compuesta y explicativa de 20 a 28 palabras con varias ideas conectadas. Luego una frase moderada de 10 palabras. Los detectores buscan uniformidad; rómpela de raíz.\n' +
        '- PERPLEJIDAD ELEVADA: Sustituye colocaciones estadísticas predecibles por alternativas léxicas naturales pero imprevistas matemáticamente.\n' +
        '- ERRADICACIÓN TOTAL DE CLICHÉS DE IA: Queda estrictamente prohibido usar términos trillados como: sumergirse, el tapiz, testimonio, crucial, en conclusión, es fundamental destacar, cabe señalar, desempeña un papel, a fin de cuentas, por consiguiente, un sinfín de, no solo... sino también, vital, primordial, en este sentido, vale la pena señalar, un abanico de, en resumen, es de vital importancia, cobra especial relevancia, sentar las bases.\n' +
        '- Preserva el 100% de los hechos, números, datos y significado original sin omitir nada.';
      break;
  }

  return 'Eres "Rewrite AI Core", el motor de humanización de texto y anti-detección 0% IA de Trujillo AI.\n' +
    'Tu labor es transformar textos redactados por IA en prosa 99,9% HUMANA, auténtica e indistinguible de la escritura de un autor nativo experto.\n\n' +
    'REQUISITO CRÍTICO 1: SOLO CAMBIA LAS PALABRAS (CORRESPONDENCIA 1:1):\n' +
    '- NO resumas, NO omitas información y NO inventes datos.\n' +
    '- Mantén una correspondencia estricta 1 a 1: cada párrafo, viñeta e idea original debe existir en el resultado reescrito.\n' +
    '- Tu labor es exclusivamente sustituir la redacción robótica, las frases cliché y la cadencia uniforme de la IA por vocabulario y ritmo humano.\n\n' +
    'REQUISITO CRÍTICO 2: CONSERVACIÓN ESTRICTA DEL FORMATO MARKDOWN:\n' +
    '- NO FUSIONES NI CONVIERTAS CLAVES, ETIQUETAS, LISTAS O VIÑETAS EN UN PÁRRAFO CORRIDO CONTINUO.\n' +
    '- Conserva cada encabezado (#, ##, ###), negrita (**), cursiva (*), lista (- o *), lista numerada (1., 2.), cita (>), tabla (| ... |) y separador (---).\n' +
    '- NO MODIFIQUES LOS BLOQUES DE CÓDIGO (``` ... ```) NI EL CÓDIGO EN LÍNEA (`...`) — DÉJALOS VERBATIM.\n' +
    '- Conserva todas las URLs y enlaces intactos.\n' +
    '- En campos con etiquetas (ej: "Nombre:", "Descripción:"), mantén cada etiqueta en su posición y reescribe únicamente el texto explicativo.\n\n' +
    'REQUISITO CRÍTICO 3: CONSERVACIÓN ESTRICTA DEL IDIOMA:\n' +
    '- El texto de entrada está en español. Tu salida DEBE ser 100% y estrictamente en español.\n' +
    '- NO traduzcas a inglés ni a ningún otro idioma bajo ninguna circunstancia.\n\n' +
    'DIRECTRICES:\n' + modeInstructions + '\n\n' +
    'REGLAS DE SALIDA:\n' +
    '- Devuelve EXCLUSIVAMENTE el texto transformado.\n' +
    '- NO agregues introducciones como "Aquí te presento el texto humanizado:", "Aquí está el resultado:", etc.\n' +
    '- Comienza directamente con la primera línea del contenido reescrito.' +
    buildStyleBlock(styleGuide, calibration);
}

async function callGroqWithLadder(prompt, systemPrompt, apiKey, requestedModel) {
  const ladder = requestedModel 
    ? [requestedModel, ...GROQ_MODEL_LADDER.filter(m => m !== requestedModel)]
    : GROQ_MODEL_LADDER;

  let lastError = null;

  for (const modelToTry of ladder) {
    try {
      const payload = {
        model: modelToTry,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.92,
        max_tokens: 3500
      };

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Groq HTTP ${res.status}`);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (text && text.trim()) {
        return { text: text.trim(), model: modelToTry };
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('All Groq models failed in fallback ladder.');
}

async function callGroqStream(prompt, systemPrompt, apiKey, requestedModel, originalText) {
  const modelToUse = requestedModel || 'llama-3.3-70b-versatile';
  const payload = {
    model: modelToUse,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    temperature: 0.92,
    max_tokens: 3500,
    stream: true
  };

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!groqRes.ok) {
    const errJson = await groqRes.json().catch(() => ({}));
    throw new Error(errJson.error?.message || `Groq Stream HTTP ${groqRes.status}`);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let fullAccumulated = '';

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const chunkStr = decoder.decode(chunk, { stream: true });
      const lines = chunkStr.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();

        if (dataStr === '[DONE]') {
          const cleaned = cleanModelOutput(fullAccumulated);
          const origM = calculateMetrics(originalText);
          const humM = calculateMetrics(cleaned);
          const donePayload = JSON.stringify({
            done: true,
            provider: `Groq LPU (${modelToUse})`,
            text: cleaned,
            metrics: {
              original: origM,
              humanized: humM,
              aiScoreEstimate: {
                originalAiProb: Math.min(99, Math.max(75, Math.round(100 - origM.burstiness * 1.1))),
                humanizedAiProb: Math.max(0, Math.min(1, Math.round(1 - (humM.burstiness / 60))))
              }
            }
          });
          controller.enqueue(encoder.encode(`data: ${donePayload}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullAccumulated += delta;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: delta })}\n\n`));
          }
        } catch (e) {}
      }
    }
  });

  return new Response(groqRes.body.pipeThrough(transformStream), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function callOpenAI(prompt, systemPrompt, apiKey, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.92,
      max_tokens: 3500
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

function fallbackHeuristicHumanizer(text, mode) {
  let processed = text;

  const replaceMap = {
    'furthermore': 'also',
    'moreover': 'besides',
    'crucial': 'vital',
    'paramount': 'key',
    'testament': 'clear proof',
    'tapestry': 'complex mix',
    'in conclusion': 'overall',
    'delve': 'dig into',
    'sumergirse': 'entrar de lleno',
    'tapiz': 'entramado',
    'testimonio': 'prueba evidente',
    'es fundamental destacar': 'conviene notar',
    'cabe señalar': 'a su vez',
    'desempeña un papel': 'actúa como factor'
  };

  for (const [aiWord, humanWord] of Object.entries(replaceMap)) {
    const reg = new RegExp(`\\b${aiWord}\\b`, 'gi');
    processed = processed.replace(reg, humanWord);
  }

  return processed;
}

function cleanModelOutput(text) {
  if (!text) return '';
  let cleaned = text.trim();
  
  // Strip AI preamble lines
  cleaned = cleaned.replace(/^(?:¡?claro!?|por supuesto|aquí\s+(?:te presento|tienes|está|adjunto)|here\s+(?:is|are)|sure|certainly)[^\n]*?:?\s*(\r?\n)+/i, '');
  cleaned = cleaned.replace(/^(?:aquí\s+(?:te presento|tienes|está)\s+el\s+texto[^\n]*?:?|versión humanizada:?|here is the (?:humanized|rewritten|proofread)[^\n]*?:?)\s*(\r?\n)*/i, '');
  
  if ((cleaned.startsWith('"""') && cleaned.endsWith('"""')) || (cleaned.startsWith("'''") && cleaned.endsWith("'''"))) {
    cleaned = cleaned.slice(3, -3).trim();
  }
  return cleaned.trim();
}

function calculateMetrics(text) {
  if (!text) {
    return { wordCount: 0, charCount: 0, burstiness: 0, clichéCount: 0 };
  }

  const words = text.trim().split(/\s+/);
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);

  let sentenceLengths = sentences.map(s => s.split(/\s+/).length);
  if (sentenceLengths.length === 0) sentenceLengths = [words.length];

  const avgLength = sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;
  const variance = sentenceLengths.reduce((a, b) => a + Math.pow(b - avgLength, 2), 0) / sentenceLengths.length;
  const stdDev = Math.sqrt(variance);

  const burstiness = Math.min(99, Math.max(10, Math.round((stdDev / (avgLength || 1)) * 45 + 50)));

  const textLower = text.toLowerCase();
  let clichéCount = 0;
  for (const w of [...BANNED_AI_WORDS_EN, ...BANNED_AI_WORDS_ES]) {
    const reg = new RegExp('\\b' + w + '\\b', 'gi');
    const matches = textLower.match(reg);
    if (matches) clichéCount += matches.length;
  }

  return {
    wordCount: words.length,
    charCount: text.length,
    burstiness,
    clichéCount
  };
}
