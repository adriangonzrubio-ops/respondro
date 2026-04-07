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
}) {
  const { category, body, rulebook, shopifyData, toneExamples } = params;

  // 1. SaaS Resilient Shopify Context
  // This handles cases where some Shopify data might be missing without crashing the prompt
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

    TONE EXAMPLES:
    ${toneExamples || "Helpful, concise, and friendly."}

    CURRENT CASE CONTEXT:
    Category: ${category}
    ${shopifyContext}

    INSTRUCTIONS:
    1. Write a direct draft response to the customer's email.
    2. Use the Shopify data provided to give specific answers.
    3. If no order is found, politely ask for their order number.
    4. STAY IN CHARACTER and follow the rulebook strictly.
    5. Output ONLY the response text. No subject lines, no intro fluff.
  `;

  try {
    // Check for API Key to prevent silent failures
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is missing in environment variables.");
    }

    const msg = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: `Customer Message: ${body}` }],
    });

    // Safely extract the text
    const firstContent = msg.content[0];
    if (firstContent && 'text' in firstContent) {
        return firstContent.text;
    }
    
    return "Draft generated, but content format was unexpected.";

  } catch (error: any) {
    // SaaS logging: This helps you debug in the Vercel logs
    console.error("❌ Claude AI Error:", error.message);
    
    // Return a more descriptive error for the merchant
    return `I'm sorry, I couldn't generate a draft. (Error: ${error.message})`;
  }
}