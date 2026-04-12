import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

export async function generateAiDraft(params: {
    category: string;
    body: string;
    rulebook: string;
    agents?: any[]; // New: Pass the active agents from the database
    shopifyData: any;
    toneExamples?: string;
    logoUrl?: string;
}) {
    const { category, body, rulebook, agents, shopifyData, toneExamples, logoUrl } = params;

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

    const systemPrompt = `
    You are an elite AI Support Team for a professional Shopify store.

    CORE CONSTITUTION (GENERAL RULEBOOK):
    ${rulebook || "Be helpful, empathetic, and professional."}

    SPECIALIZED AGENT KNOWLEDGE:
    ${agentContext || "No specialized agents active currently."}

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

    // SaaS Identity Glue: We only add what's in the store's settings.
    const signatureText = toneExamples ? `\n\n${toneExamples}` : "";
// We replace the massive logo data with a simple placeholder tag
    const logoMarker = logoUrl ? `\n\n[LOGO]` : "";

    return draft + signatureText + logoMarker;

  } catch (error: any) {
    console.error("❌ Claude AI Error:", error.message);
    return `I'm sorry, I couldn't generate a draft. (Error: ${error.message})`;
  }
}