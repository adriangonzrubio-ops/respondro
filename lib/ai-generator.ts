import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function generateAiDraft(params: {
    category: string,
    body: string,
    rulebook: string,
    shopifyData: any,
    toneExamples?: string
}) {
    const { category, body, rulebook, shopifyData, toneExamples } = params;

    const shopifyContext = shopifyData 
        ? `Order Context: Order ${shopifyData.orderNumber}, Status: ${shopifyData.status}, Tracking: ${shopifyData.tracking?.[0]?.url || 'Not available'}. Items: ${shopifyData.items}`
        : "No Shopify order found for this email address.";

    const systemPrompt = `
        You are an elite Customer Service AI for a Shopify store. 
        
        YOUR CONSTITUTION (RULEBOOK):
        ${rulebook || "Be helpful and professional."}

        TONE EXAMPLES:
        ${toneExamples || "Helpful, concise, and friendly."}

        CURRENT CASE:
        Category: ${category}
        ${shopifyContext}

        INSTRUCTIONS:
        1. Write a draft response to the customer's email.
        2. If you have tracking info, include it.
        3. If no order is found, politely ask for their order number.
        4. STAY IN CHARACTER and follow the rulebook strictly.
        5. Output ONLY the response text. Do not include subject lines or greetings like "Sure, here is a draft."
    `;

    try {
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: "user", content: `Customer Message: ${body}` }],
        });

        // Safely extract the text from Claude's response
        const content = msg.content[0];
        return content.type === 'text' ? content.text : '';
    } catch (error) {
        console.error("Claude Draft Error:", error);
        return "I'm sorry, I couldn't generate a draft at this time.";
    }
}