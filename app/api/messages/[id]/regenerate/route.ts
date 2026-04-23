import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { generateAiDraft } from '@/lib/ai-generator';
import { getShopifyContext, extractOrderNumber } from '@/lib/shopify';
import { decrypt } from '@/lib/encryption';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const body = await req.json().catch(() => ({}));

        // 1. Fetch the message
        const { data: message } = await supabaseAdmin.from('messages').select('*').eq('id', id).single();
        if (!message) return NextResponse.json({ error: 'Message not found' }, { status: 404 });

        // 2. Get store_id
        let storeId = message.store_id;
        if (!storeId) {
            const { data: conn } = await supabaseAdmin.from('user_connections').select('store_id').eq('id', message.connection_id).single();
            storeId = conn?.store_id;
        }
        if (!storeId) {
            const { data: firstStore } = await supabaseAdmin.from('stores').select('id').limit(1).single();
            storeId = firstStore?.id;
        }

        // 3. Fetch settings
        let settings: any = null;
        if (storeId) {
            const { data: s } = await supabaseAdmin.from('settings').select('*').eq('store_id', storeId).maybeSingle();
            settings = s;
        }

        // 4. Fetch Shopify credentials from STORES table (not settings)
        let shopUrl = '';
        let shopToken = '';
        if (storeId) {
            const { data: store } = await supabaseAdmin.from('stores').select('shopify_url, shopify_token').eq('id', storeId).single();
            if (store?.shopify_url && store?.shopify_token) {
                shopUrl = store.shopify_url;
                shopToken = decrypt(store.shopify_token);
            }
        }

        // 5. Fetch fresh Shopify data
        let freshShopifyData: any = null;
        if (shopUrl && shopToken) {
            const senderEmail = message.sender?.includes('<')
                ? message.sender.split('<')[1].replace('>', '').trim()
                : message.sender;
            const senderName = (message.sender || '').split('<')[0].replace(/"/g, '').trim();
            const orderNum = extractOrderNumber((message.body_text || '') + ' ' + (message.subject || ''));

            freshShopifyData = await getShopifyContext(shopUrl, shopToken, senderEmail || '', orderNum, senderName);

            if (freshShopifyData && freshShopifyData.length > 0) {
                await supabaseAdmin.from('messages').update({ shopify_data: freshShopifyData }).eq('id', id);
            }
        }

        // 6. Build rulebook and generate draft
        const finalRulebook = body.rulebook || settings?.rulebook || 'Be professional.';
        const finalSignature = body.signature || settings?.signature || '';

        const shopifyForAI = freshShopifyData && freshShopifyData.length > 0
            ? freshShopifyData
            : message.shopify_data || {};

        // Load agent rulebooks for richer context
        let agents: any[] = [];
        if (storeId) {
            const { data: agentData } = await supabaseAdmin.from('support_agents').select('agent_type, rulebook, is_enabled, tone_preset, custom_tone_description').eq('store_id', storeId);
            agents = agentData || [];
        }

        // Find tone settings (prefer customer_service agent, fallback to first enabled)
        const toneAgent = agents.find(a => a.agent_type === 'customer_service' && a.is_enabled)
            || agents.find(a => a.is_enabled);

        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text || '',
            rulebook: finalRulebook,
            agents: agents,
            shopifyData: shopifyForAI,
            toneExamples: finalSignature,
            tonePreset: toneAgent?.tone_preset,
            customToneDescription: toneAgent?.custom_tone_description
        });

        await supabaseAdmin.from('messages').update({ ai_draft: aiDraft }).eq('id', id);

        // Log the AI action (fails silently)
        if (storeId) {
            try {
                const { logAiAction, extractEmail, extractName } = await import('@/lib/ai-action-logger');
                await logAiAction({
                    storeId,
                    messageId: id,
                    actionType: 'draft_generated',
                    summary: `Regenerated draft for ${extractName(message.sender) || 'customer'}`,
                    customerEmail: extractEmail(message.sender),
                    customerName: extractName(message.sender),
                    subject: message.subject,
                    aiModel: 'claude-sonnet-4-6',
                    details: { trigger: 'manual_regenerate' }
                });
            } catch (logErr) {
                console.error('Logging error (non-blocking):', logErr);
            }
        }

        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error('❌ Regenerate error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}