import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function classifyAndDraft(
  subject: string,
  body: string,
  rulebook: string,
  storeName: string,
  shopifyData: any,
  signature?: string
) {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: `
You are the Lead Support Agent for ${storeName}.

RULEBOOK: ${rulebook}
CUSTOMER EMAIL SUBJECT: ${subject}
CUSTOMER EMAIL BODY: ${body}
SHOPIFY DATA: ${JSON.stringify(shopifyData)}

CLASSIFICATION RULES:
Set path to "AUTOMATE" when ALL of these are true:
- You have enough data to give a complete, accurate answer
- The inquiry is standard (tracking updates, shipping info, product questions, order confirmations)
- Shopify data confirms the order details
- No refund, cancellation, or complaint requiring human judgment
- The customer tone is neutral or positive

Set path to "REVIEW" when ANY of these are true:
- Customer is angry, upset, or threatening
- Refund or cancellation is requested
- You lack data to answer confidently (no Shopify match, unclear question)
- The email mentions legal action, fraud, or chargebacks
- The request requires a judgment call not covered by the rulebook
- The email is from a marketing service, newsletter, or automated system (not a real customer)

WRITING RULES:
- Write in plain text only. NEVER use markdown like ** or __ or # or bullet points.
- Sound like a friendly, competent human, not a chatbot.
- Keep paragraphs short (2-3 sentences).
- Start with "Hi [first name]," if you can identify their name.
- Use specific order data when available.
- DO NOT write any sign-off or signature.

Return ONLY valid JSON: { "path": "AUTOMATE" | "REVIEW", "category": "string", "priority": "Low" | "Medium" | "High", "draft": "string", "reason": "string" }`
            }],
        });
        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        const parsed = JSON.parse(content);

        if (signature && parsed.draft) {
            parsed.draft = parsed.draft.trim() + '\n\n' + signature;
        }

        return parsed;
    } catch (error) {
        const fallbackDraft = `Hi,\n\nThank you for reaching out. We have received your message and will get back to you as soon as possible.${signature ? '\n\n' + signature : ''}`;
        return { path: "REVIEW", category: "General", priority: "Medium", draft: fallbackDraft, reason: "AI error — fallback used." };
    }
}