import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

interface ClassificationResult {
  path: 'AUTOMATE' | 'REVIEW' | 'SPAM';
  category: string;
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
  draft: string;
  reason: string;
  confidence: number;
}

export async function classifyAndDraft(
  subject: string,
  body: string,
  rulebook: string,
  storeName: string,
  shopifyData: any,
  signature?: string,
  previousCategory?: string | null,
  previousStatus?: string | null
): Promise<ClassificationResult> {
    try {
        let escalationContext = '';
        if (previousCategory && previousStatus) {
            escalationContext = `
PREVIOUS TICKET CONTEXT:
- Previously categorized as: "${previousCategory}" (status: ${previousStatus})
- If intent has CHANGED or ESCALATED, update category and increase priority.`;
        }

        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1200,
            messages: [{
                role: 'user',
                content: `You are a support agent for ${storeName}. Classify this email and write a reply.

RULEBOOK:
${rulebook}

EMAIL SUBJECT: ${subject}
EMAIL BODY: ${body}

SHOPIFY DATA: ${JSON.stringify(shopifyData)}
${escalationContext}

CATEGORIES (pick one):
order_status, shipping, refund_request, cancellation, exchange, return, address_change, damaged_item, missing_item, product_question, billing, complaint, thank_you, general, spam

PATH RULES:
SPAM = marketing, newsletters, automated notifications, vendor promos, phishing, not a real customer. Draft must be empty string.
AUTOMATE = you have Shopify data, standard inquiry (order_status/shipping/product_question/thank_you/address_change), neutral tone, confidence 85%+, no refund/cancellation/complaint needed
REVIEW = refund/cancellation/complaint/damaged/missing/billing/exchange, angry customer, insufficient data, legal threats, confidence below 85%

PRIORITY:
Urgent = legal threats, chargebacks, orders over $500
High = refunds, cancellations, damaged items, angry customers
Medium = standard with some complexity
Low = simple questions, thank-yous, spam

CRITICAL DRAFT RULES:
1. The "draft" field must ONLY contain the email text you send to the customer
2. NEVER put analysis, thinking, situation assessment, or internal notes in "draft"
3. NEVER start draft with "Looking at", "Based on", "Let me check", "I can see that"
4. Start with "Hi [name]," then directly address their question
5. Put ALL your reasoning and analysis in the "reason" field instead
6. Plain text only, no markdown
7. Short paragraphs, friendly human tone
8. Use real data from Shopify (order numbers, tracking, products)
9. No sign-off or signature, no placeholders like [Name]
10. Match customer's language if not English

OUTPUT - Return ONLY this JSON:
{"path":"AUTOMATE|REVIEW|SPAM","category":"category","priority":"Low|Medium|High|Urgent","draft":"customer-facing email only","reason":"internal analysis","confidence":0-100}`
            }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in AI response');
        
        const parsed: ClassificationResult = JSON.parse(jsonMatch[0]);

        // Strip markdown from draft
        if (parsed.draft) {
            parsed.draft = parsed.draft
                .replace(/\*\*/g, '')
                .replace(/__/g, '')
                .replace(/^#+\s/gm, '')
                .replace(/^[-*]\s/gm, '');
            
            // Safety: strip any "thinking" that leaked into the draft
            let lines = parsed.draft.split('\n');
            let emailStart = 0;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                // Found the actual email greeting
                if (line.match(/^(Hi|Hello|Hey|Dear|Good morning|Good afternoon|Good evening|Thank you for|Thanks for)/i)) {
                    emailStart = i;
                    break;
                }
                // These are analysis lines — skip them
                if (line.match(/^(Looking at|Based on|Let me|I can see|The order|The customer|This qualifies|This is a|No prior|Days since|That's \d|Order #?\d|---)/i) || line === '') {
                    emailStart = i + 1;
                }
            }
            
            if (emailStart > 0 && emailStart < lines.length) {
                parsed.draft = lines.slice(emailStart).join('\n').trim();
            }
        }

        // Append signature for non-spam
        if (signature && parsed.draft && parsed.path !== 'SPAM') {
            parsed.draft = parsed.draft.trim() + '\n\n' + signature;
        }

        // Safety: low confidence → REVIEW
        if (parsed.path === 'AUTOMATE' && (parsed.confidence || 0) < 85) {
            parsed.path = 'REVIEW';
            parsed.reason = (parsed.reason || '') + ' [Downgraded: confidence below 85%]';
        }

        // Safety: dangerous categories never auto-send
        const reviewOnly = ['refund_request', 'cancellation', 'complaint', 'damaged_item', 'missing_item', 'billing', 'exchange'];
        if (parsed.path === 'AUTOMATE' && reviewOnly.includes(parsed.category)) {
            parsed.path = 'REVIEW';
            parsed.reason = (parsed.reason || '') + ` [Downgraded: ${parsed.category} requires human review]`;
        }

        return parsed;

    } catch (error: any) {
        console.error('❌ AI Classifier error:', error.message);
        
        const customerName = body.match(/(?:^|\n)\s*([A-Z][a-z]+ ?[A-Z]?[a-z]*)\s*$/m)?.[1] || '';
        const greeting = customerName ? `Hi ${customerName.split(' ')[0]},` : 'Hi,';
        const hasOrder = shopifyData && JSON.stringify(shopifyData).length > 10;
        
        let fallbackDraft = hasOrder
            ? `${greeting}\n\nThank you for contacting us. I can see your order details and am looking into this for you. I will follow up shortly with a full update.`
            : `${greeting}\n\nThank you for reaching out. I am looking into your inquiry and will get back to you shortly with more details.`;
        if (signature) fallbackDraft += '\n\n' + signature;
        
        return { path: 'REVIEW', category: 'general', priority: 'Medium', draft: fallbackDraft, reason: `AI error — fallback: ${error.message}`, confidence: 0 };
    }
}