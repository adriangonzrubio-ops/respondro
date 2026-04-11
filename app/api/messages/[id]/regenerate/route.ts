import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '@/lib/ai-generator';
import { getShopifyContext, extractOrderNumber } from '@/lib/shopify';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const body = await req.json().catch(() => ({}));

        // 1. Fetch the message
        const { data: message } = await supabase.from('messages').select('*').eq('id', id).single();
        if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

        // 2. Fetch Store ID
        let storeId = null;
        const { data: conn } = await supabase.from('user_connections').select('store_id').eq('id', message.connection_id).single();
        if (conn?.store_id) {
            storeId = conn.store_id;
        } else {
            const { data: firstStore } = await supabase.from('stores').select('id').limit(1).single();
            storeId = firstStore?.id;
        }

        // 3. Fetch Settings
        const { data: settings } = await supabase.from('settings').select('*').eq('store_id', storeId).maybeSingle();

        // 4. ALWAYS fetch fresh Shopify data on regenerate
        let freshShopifyData: any = null;
        if (settings?.shop_url && settings?.shopify_access_token) {
            const senderEmail = message.sender?.includes('<')
                ? message.sender.split('<')[1].replace('>', '').trim()
                : message.sender;
            const senderName = (message.sender || '').split('<')[0].replace(/"/g, '').trim();
            const orderNum = extractOrderNumber((message.body_text || '') + ' ' + (message.subject || ''));

            freshShopifyData = await getShopifyContext(
                settings.shop_url,
                settings.shopify_access_token,
                senderEmail || '',
                orderNum,
                senderName
            );

            // Cache the fresh data
            if (freshShopifyData && freshShopifyData.length > 0) {
                await supabase.from('messages').update({ shopify_data: freshShopifyData }).eq('id', id);
            }
        }

        // 5. Use frontend rulebook if provided, otherwise database
        const finalRulebook = body.rulebook || settings?.rulebook || "Be professional.";
        const finalSignature = body.signature || settings?.signature || "";
        const shopifyForAI = freshShopifyData && freshShopifyData.length > 0
            ? freshShopifyData
            : message.shopify_data || {};

        // 6. Generate AI Draft with fresh data
        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text || "",
            rulebook: finalRulebook,
            shopifyData: shopifyForAI,
            toneExamples: finalSignature,
            logoUrl: settings?.logo_url || ""
        });

        // 7. Save and return
        await supabase.from('messages').update({ ai_draft: aiDraft }).eq('id', id);
        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error("❌ Critical Regenerate Error:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}