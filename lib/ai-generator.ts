import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

export async function generateAiDraft(params: {
  category: string;
  body: string;
  rulebook: string;
  shopifyData: any;
  toneExamples?: string; 
  logoUrl?: string;     
}) {
  const { category, body, rulebook, shopifyData, toneExamples, logoUrl } = params;

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

const systemPrompt = `
    You are an elite Customer Service AI for a professional Shopify store.

    YOUR CONSTITUTION (RULEBOOK):
    ${rulebook || "Be helpful, empathetic, and professional."}

    CURRENT CASE CONTEXT:
    Category: ${category}
    ${shopifyContext}

    INSTRUCTIONS:
    1. Write a direct, empathetic response to the customer.
    2. Start with a proper greeting (e.g., "Hi [Name]").
    3. Use the Shopify data to be specific about their order.
    4. STAY IN CHARACTER and follow the rulebook.
    5. Output ONLY the email body.
    6. CRITICAL: DO NOT include a sign-off or signature (e.g., "Best regards"). 
       The system adds the store's signature automatically. Stop after the last sentence.
  `;

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is missing.");
    }

    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: `Customer Message: ${body}` }],
    });

let draft = "";
    const firstContent = msg.content[0];
    if (firstContent && 'text' in firstContent) {
        // .trim() is the secret—it removes the AI's trailing newlines
        draft = firstContent.text.trim(); 
    }

    // SaaS Identity Glue: We only add what's in the store's settings.
    const signatureText = toneExamples ? `\n\n${toneExamples}` : "";
    const logoHtml = logoUrl ? `\n\n[LOGO_START]${logoUrl}[LOGO_END]` : "";

    return draft + signatureText + logoHtml;

  } catch (error: any) {
    console.error("❌ Claude AI Error:", error.message);
    return `I'm sorry, I couldn't generate a draft. (Error: ${error.message})`;
  }
}