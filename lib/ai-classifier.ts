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
CUSTOMER EMAIL: ${body}
SHOPIFY DATA: ${JSON.stringify(shopifyData)}

TASK:
1. If Shopify data gives a clear answer, set path to "AUTOMATE".
2. Write a warm, professional reply addressing the customer's issue.
3. Start with "Hi [first name]," if you can identify their name.
4. DO NOT write any sign-off or signature — it will be added automatically.
5. End the email body just before where a signature would go.

Return ONLY valid JSON: { "path": "AUTOMATE" | "REVIEW", "category": "string", "priority": "Low" | "Medium" | "High", "draft": "string", "reason": "string" }`
            }],
        });
        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        const parsed = JSON.parse(content);
        
        // Append stored signature if provided
        if (signature && parsed.draft) {
            parsed.draft = parsed.draft.trim() + '\n\n' + signature;
        }
        
        return parsed;
    } catch (error) {
        const fallbackDraft = `Hi,\n\nThank you for reaching out. We have received your message and will get back to you as soon as possible.${signature ? '\n\n' + signature : ''}`;
        return { path: "REVIEW", category: "General", priority: "Medium", draft: fallbackDraft, reason: "AI error — fallback used." };
    }
}