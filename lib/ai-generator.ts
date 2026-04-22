import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

// ─── TONE OF VOICE TEMPLATES ──────────────────────────────
const TONE_TEMPLATES: Record<string, string> = {
  professional: "Use a polished, formal tone. Write in complete sentences with proper grammar. Avoid contractions, emojis, and casual language. Be courteous and measured. Use phrases like 'Thank you for reaching out' and 'We appreciate your patience.'",
  
  friendly: "Use a warm, conversational tone. Contractions like 'I'm' and 'we've' are welcome. Occasional emojis are fine when they fit naturally (maximum 1-2 per email). Sound approachable and human, not robotic.",
  
  warm: "Use an enthusiastic, genuinely caring tone. Show real excitement about helping the customer. Use natural exclamation points where appropriate (not excessively). Make the customer feel valued and important.",
  
  caring: "Use a calm, empathetic tone. ALWAYS acknowledge the customer's feelings or situation first before jumping to solutions. Use phrases like 'I completely understand' and 'I'm so sorry to hear that.' Be patient, reassuring, and never rushed.",
  
  playful: "Use a casual, upbeat tone with personality. Emojis are welcome and encouraged where they fit naturally (2-4 per email). Short, punchy sentences. Write like you're texting a friend — but still professional. Energetic and fun.",
  
  luxury: "Use a refined, confident tone. Keep sentences short and deliberate. Sophisticated vocabulary without pretension. Minimal emojis (rare or none). Every word should feel chosen on purpose. Reflect premium brand values."
};
// ──────────────────────────────────────────────────────────

export async function generateAiDraft(params: {
    category: string;
    body: string;
    rulebook: string;
    agents?: any[]; // New: Pass the active agents from the database
    shopifyData: any;
    toneExamples?: string;
    logoUrl?: string;
    tonePreset?: string;          // NEW: tone template key
    customToneDescription?: string; // NEW: merchant's custom tone (if preset = 'custom')
}) {
    const { category, body, rulebook, agents, shopifyData, toneExamples, logoUrl, tonePreset, customToneDescription } = params;

  // 1. SaaS Resilient Shopify Context
  let shopifyContext = "No specific Shopify order data found for this customer.";
  
  if (shopifyData && typeof shopifyData === 'object' && Object.keys(shopifyData).length > 0) {
    const orderNum = shopifyData.orderNumber || shopifyData.name || 'Unknown';
    const status = shopifyData.status || shopifyData.displayFinancialStatus || 'Processing';
    const trackingUrl = shopifyData.tracking?.[0]?.url || 'No tracking link yet';
    
    shopifyContext = `
      ORDER INFO:
      - Order Number: ${orderNum}
      - Status: ${status}
      - Tracking Link: ${trackingUrl}
    `;
  }

// 1.5 Build Specialized Agent Context
    const activeAgents = agents?.filter(a => a.is_enabled) || [];
    const agentContext = activeAgents.map(a => 
        `AGENT [${a.agent_type.toUpperCase()}]: ${a.rulebook}`
    ).join('\n');

    // 1.6 Build Tone of Voice Guidance
    let toneGuidance = "";
    if (tonePreset === 'custom' && customToneDescription) {
        toneGuidance = customToneDescription;
    } else if (tonePreset && TONE_TEMPLATES[tonePreset]) {
        toneGuidance = TONE_TEMPLATES[tonePreset];
    } else {
        // Default to 'friendly' if nothing set
        toneGuidance = TONE_TEMPLATES.friendly;
    }

    const systemPrompt = `
    You are an elite AI Support Team for a professional Shopify store.

    CORE CONSTITUTION (GENERAL RULEBOOK):
    ${rulebook || "Be helpful, empathetic, and professional."}

    SPECIALIZED AGENT KNOWLEDGE:
    ${agentContext || "No specialized agents active currently."}

    TONE OF VOICE:
    ${toneGuidance}

    CURRENT CASE CONTEXT:
    Category: ${category}
    ${shopifyContext}

    INSTRUCTIONS:
    1. Determine which agent knowledge (Shipping, Product, or General) is most relevant.
    2. Write a direct, empathetic response to the customer.
    3. Start with a proper greeting (e.g., "Hi [Name]").
    4. Use the Shopify data to be specific about their order.
    5. STAY IN CHARACTER and follow the rulebook.
    6. Output ONLY the email body.
    7. CRITICAL: DO NOT include a sign-off or signature.
    8. ABSOLUTE RULE — NEVER use markdown formatting. No ** or __, no # headers, no bullet points, no numbered lists. Write in plain text ONLY, exactly as a human would type in a real email. If you catch yourself adding **, remove it. This is a strict requirement.
    9. Write naturally and conversationally. Avoid corporate buzzwords. Sound like a friendly, competent human — not an AI chatbot.
    10. Keep paragraphs short (2-3 sentences max). Use line breaks between paragraphs.
    `;

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is missing.");
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: `Customer Message: ${body}` }],
    });

let draft = "";
    const firstContent = msg.content[0];
    if (firstContent && 'text' in firstContent) {
        draft = firstContent.text.trim();
        // Keep ** for bold rendering in UI, but strip other markdown
        draft = draft.replace(/__/g, '').replace(/^#+\s/gm, '').replace(/^[-*]\s/gm, '');
    }

    // Append signature if provided
    const signatureText = toneExamples ? `\n\n${toneExamples}` : "";

    return draft + signatureText;

  } catch (error: any) {
    console.error("❌ Claude AI Error:", error.message);
    return `I'm sorry, I couldn't generate a draft. (Error: ${error.message})`;
  }
}