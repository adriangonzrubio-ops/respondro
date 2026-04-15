import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Anthropic } from '@anthropic-ai/sdk';

export async function GET(request: Request) {
    // Redirect GET to POST so you can call it from browser
    return POST(request);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min max on Vercel

export async function POST(request: Request) {
    // Security check
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    const origin = request.headers.get('origin') || request.headers.get('referer') || '';
    const isSameOrigin = origin.includes('respondro.vercel.app') || origin.includes('respondro.ai') || origin.includes('localhost');
    
    if (!isSameOrigin && key !== process.env.WORKER_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const body = await request.json().catch(() => ({}));
        const batchSize = body.batch || parseInt(searchParams.get('batch') || '15');

        // Fetch messages still labeled "General" or "general"
        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, subject, body_text, sender, shopify_data, status')
            .or('category.eq.General,category.eq.general,category.is.null')
            .order('received_at', { ascending: false })
            .limit(batchSize);

        if (error) throw error;
        if (!messages || messages.length === 0) {
            return NextResponse.json({ success: true, message: 'No General emails left to reclassify', updated: 0 });
        }

        let updated = 0;

        for (const msg of messages) {
            try {
                const response = await anthropic.messages.create({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 300,
                    messages: [{
                        role: 'user',
                        content: `Classify this customer support email. Pick ONE category and priority.

SUBJECT: ${msg.subject || '(no subject)'}
BODY: ${(msg.body_text || '').substring(0, 500)}
SHOPIFY DATA: ${JSON.stringify(msg.shopify_data || {}).substring(0, 300)}

CATEGORIES: order_status, shipping, refund_request, cancellation, exchange, return, address_change, damaged_item, missing_item, product_question, billing, complaint, thank_you, general, spam

PRIORITY: Low, Medium, High, Urgent
- Urgent: legal threats, chargebacks
- High: refunds, cancellations, damage, angry customer
- Medium: standard inquiries
- Low: simple questions, thank-yous, spam

Return ONLY JSON: {"category":"...","priority":"...","is_spam":true|false}`
                    }],
                });

                const content = response.content[0].type === 'text' ? response.content[0].text : '';
                const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
                const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
                if (!jsonMatch) continue;
                
                const result = JSON.parse(jsonMatch[0]);
                
                const updateData: any = {
                    category: result.category || 'general',
                    priority: result.priority || 'Medium',
                };

                // If spam and not already sent, mark as spam
                if (result.is_spam && msg.status !== 'done' && msg.status !== 'automated') {
                    updateData.status = 'spam';
                }

                await supabase.from('messages').update(updateData).eq('id', msg.id);
                updated++;
                console.log(`📌 Reclassified ${msg.id}: ${result.category} (${result.priority})`);

            } catch (aiErr: any) {
                console.error(`❌ Reclassify failed for ${msg.id}:`, aiErr.message);
            }
        }

        return NextResponse.json({ 
            success: true, 
            updated, 
            remaining: messages.length - updated,
            message: `Reclassified ${updated}/${messages.length} emails. Run again for more.`
        });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}