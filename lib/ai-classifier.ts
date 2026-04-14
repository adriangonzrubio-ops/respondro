import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export interface ClassificationResult {
  path: 'AUTOMATE' | 'REVIEW' | 'SPAM';
  category: string;
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
  draft: string;
  reason: string;
  confidence: number;
  required_action: 'refund' | 'cancel' | 'address_change' | 'none';
  action_parameters: {
    order_number?: string;
    refund_amount?: number;
    refund_type?: 'full' | 'partial';
    new_address?: any;
    cancel_reason?: string;
  } | null;
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
PREVIOUS TICKET: Category was "${previousCategory}" (status: ${previousStatus}). If intent changed, update accordingly.`;
        }

        const hasShopifyData = shopifyData && JSON.stringify(shopifyData).length > 20;

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: `You are an autonomous customer service AI for ${storeName}. Your job is to classify emails, detect required Shopify actions, and draft replies.

STORE RULEBOOK:
${rulebook}

EMAIL SUBJECT: ${subject}
EMAIL BODY: ${body}

SHOPIFY ORDER DATA: ${JSON.stringify(shopifyData)}
${escalationContext}

═══ YOUR TASKS ═══

TASK 1 — CLASSIFY the email into one category:
order_status, shipping, refund_request, cancellation, exchange, return, address_change, damaged_item, missing_item, product_question, billing, complaint, thank_you, general, spam

TASK 2 — DETECT if a Shopify action is needed:
- "refund" → Customer explicitly requests money back. Extract order number and whether full or partial.
- "cancel" → Customer explicitly asks to cancel their order. Extract order number.
- "address_change" → Customer wants to update shipping address. Extract order number and new address.
- "none" → No Shopify mutation needed (just a reply).

TASK 3 — DECIDE the path:

PATH = "SPAM" when: marketing, newsletters, automated notifications, not a real customer. Set draft to "".

PATH = "AUTOMATE" when ALL are true:
- Confidence is 90% or higher
- You have Shopify data to give a specific, complete answer
- For actions: the rulebook permits the action AND you have all required data (order number, address, etc.)
- For simple queries: order_status, shipping, product_question, thank_you with clear answers
- Customer tone is not hostile or threatening

PATH = "REVIEW" when ANY is true:
- Confidence below 90%
- No Shopify data found for the customer
- Action requested but rulebook forbids it or is ambiguous
- Customer is angry, hostile, or threatening
- Legal threats, chargebacks, fraud mentions
- The request is complex or ambiguous
- Action would fail (order already fulfilled/cancelled/fully refunded)

TASK 4 — DRAFT the email reply:
${hasShopifyData ? `
FOR AUTOMATED ACTIONS — Write as if the action HAS ALREADY BEEN COMPLETED:
- Refund: "I have processed a [full/partial] refund of [currency] [amount] for your order #[number]. You should see it back in your account within 5-10 business days."
- Cancel: "I have cancelled your order #[number]. Your refund of [currency] [amount] will be processed automatically."
- Address change: "I have updated the shipping address for your order #[number] to [new address]."
` : ''}
FOR REVIEW PATH — Write a helpful draft that the human agent can edit before sending.

DRAFT RULES:
- Output ONLY the customer-facing email text in the "draft" field
- NEVER include thinking, analysis, or internal notes in the draft
- Start with "Hi [first name]," using real name from the email
- Use specific Shopify data (order numbers, tracking, products, amounts)
- Plain text only, no markdown
- Short paragraphs, friendly human tone
- No sign-off or signature
- Match customer's language if not English

═══ ACTION PARAMETER RULES ═══

For "refund":
- order_number: The order number from the email or Shopify data
- refund_type: "full" if customer says full/complete refund or doesn't specify, "partial" if they mention a specific amount or percentage
- refund_amount: Only set if partial — the specific amount in the order's currency. For full refunds, leave null (system calculates remaining).

For "cancel":
- order_number: The order number
- cancel_reason: Brief reason ("customer changed mind", "ordered wrong item", etc.)

For "address_change":
- order_number: The order number
- new_address: An object with address1, city, zip, country (parse from email text). If you can only get a partial address string, set new_address as the string.

═══ OUTPUT — Return ONLY this JSON ═══
{
  "path": "AUTOMATE|REVIEW|SPAM",
  "category": "category_name",
  "priority": "Low|Medium|High|Urgent",
  "confidence": 0-100,
  "required_action": "refund|cancel|address_change|none",
  "action_parameters": { ... } or null,
  "draft": "customer-facing email only",
  "reason": "internal reasoning for the human dashboard"
}`
            }],
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';
        const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in AI response');
        
        const parsed: ClassificationResult = JSON.parse(jsonMatch[0]);

        // Clean draft
        if (parsed.draft) {
            parsed.draft = parsed.draft.replace(/\*\*/g, '').replace(/__/g, '').replace(/^#+\s/gm, '').replace(/^[-*]\s/gm, '');
            
            // Strip any thinking that leaked into draft
            let lines = parsed.draft.split('\n');
            let emailStart = 0;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.match(/^(Hi|Hello|Hey|Dear|Good morning|Good afternoon|Thank you for|Thanks for|I have|I've|Your order)/i)) {
                    emailStart = i;
                    break;
                }
                if (line.match(/^(Looking at|Based on|Let me|I can see|The order|The customer|This qualifies|---)/i) || line === '') {
                    emailStart = i + 1;
                }
            }
            if (emailStart > 0 && emailStart < lines.length) {
                parsed.draft = lines.slice(emailStart).join('\n').trim();
            }
        }

        // Append signature
        if (signature && parsed.draft && parsed.path !== 'SPAM') {
            parsed.draft = parsed.draft.trim() + '\n\n' + signature;
        }

        // Empty draft for spam
        if (parsed.path === 'SPAM') {
            parsed.draft = '';
            parsed.required_action = 'none';
            parsed.action_parameters = null;
        }

        // Safety: confidence < 90 → REVIEW
        if (parsed.path === 'AUTOMATE' && (parsed.confidence || 0) < 90) {
            parsed.path = 'REVIEW';
            parsed.reason = (parsed.reason || '') + ' [Downgraded: confidence ' + parsed.confidence + '% < 90%]';
        }

        // Safety: if action detected but no Shopify data, force REVIEW
        if (parsed.required_action !== 'none' && !hasShopifyData) {
            parsed.path = 'REVIEW';
            parsed.reason = (parsed.reason || '') + ' [Downgraded: action requested but no Shopify data available]';
        }

        // Safety: if action but no order number, force REVIEW
        if (parsed.required_action !== 'none' && parsed.action_parameters && !parsed.action_parameters.order_number) {
            parsed.path = 'REVIEW';
            parsed.reason = (parsed.reason || '') + ' [Downgraded: action requested but no order number detected]';
        }

        return parsed;

    } catch (error: any) {
        console.error('❌ AI Classifier error:', error.message);

        // Retry with simpler prompt
        try {
            const retry = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 800,
                messages: [{
                    role: 'user',
                    content: `Classify this customer email for ${storeName} and write a reply.
Subject: ${subject}
Body: ${body.substring(0, 500)}
Shopify: ${JSON.stringify(shopifyData).substring(0, 500)}

Categories: order_status, shipping, refund_request, cancellation, exchange, return, address_change, damaged_item, missing_item, product_question, billing, complaint, thank_you, general, spam

Return JSON: {"path":"REVIEW","category":"pick_one","priority":"Medium","confidence":50,"required_action":"none","action_parameters":null,"draft":"Hi, your reply here","reason":"why"}`
                }],
            });
            const retryContent = retry.content[0].type === 'text' ? retry.content[0].text : '';
            const retryMatch = retryContent.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim().match(/\{[\s\S]*\}/);
            if (retryMatch) {
                const p = JSON.parse(retryMatch[0]);
                if (p.draft) p.draft = p.draft.replace(/\*\*/g, '');
                if (signature && p.draft && p.path !== 'SPAM') p.draft = p.draft.trim() + '\n\n' + signature;
                p.required_action = p.required_action || 'none';
                p.action_parameters = p.action_parameters || null;
                p.reason = (p.reason || '') + ' [retry after first attempt failed]';
                return p;
            }
        } catch (retryErr: any) {
            console.error('❌ Retry also failed:', retryErr.message);
        }

        // Final fallback
        const customerName = body.match(/(?:^|\n)\s*([A-Z][a-z]+ ?[A-Z]?[a-z]*)\s*$/m)?.[1] || '';
        const greeting = customerName ? `Hi ${customerName.split(' ')[0]},` : 'Hi,';
        let fallbackDraft = `${greeting}\n\nThank you for reaching out. I am looking into your inquiry and will get back to you shortly with more details.`;
        if (signature) fallbackDraft += '\n\n' + signature;

        return {
            path: 'REVIEW', category: 'general', priority: 'Medium',
            draft: fallbackDraft, reason: `AI error — fallback: ${error.message}`,
            confidence: 0, required_action: 'none', action_parameters: null
        };
    }
}