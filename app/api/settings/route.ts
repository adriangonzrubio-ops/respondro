import { NextResponse } from 'next/server';
import { supabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { data: settings } = await supabase.from('settings').select('*').single();
    const { data: storeData } = await supabase.from('stores').select('*').single();
    const { data: connections } = await supabase.from('user_connections').select('*');
    const emailConn = connections?.find(c => c.imap_host || c.gmail_access_token);

    const responseData = {
      // Branding
      rulebook: settings?.rulebook || storeData?.rulebook || '',
      signature: settings?.signature || '',
      logo_url: settings?.logo_url || '',
      logo_width: settings?.logo_width || '120',
      store_name: settings?.store_name || storeData?.store_name || '',
      // Connections
      has_shopify: !!storeData?.shopify_token, 
      shop_url: storeData?.shopify_url || '',
      has_email: !!emailConn,
      connected_email: emailConn?.email || '',
      imap_host: emailConn?.imap_host || '',
      store_id: settings?.store_id || storeData?.id || null,
      // Autonomy settings
      auto_reply_enabled: settings?.auto_reply_enabled || false,
      auto_refund_enabled: settings?.auto_refund_enabled || false,
      auto_cancel_enabled: settings?.auto_cancel_enabled || false,
      auto_address_change_enabled: settings?.auto_address_change_enabled || false,
      auto_reply_delay_minutes: settings?.auto_reply_delay_minutes || 5,
      max_auto_refund_amount: settings?.max_auto_refund_amount || 50,
    };

    console.log("📡 API returning truth:", responseData);
    return NextResponse.json(responseData);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Build update object with only the fields that were sent
    const updateData: any = { id: 1 };
    
    // Branding fields
    if (body.rulebook !== undefined) updateData.rulebook = body.rulebook;
    if (body.logo_url !== undefined) updateData.logo_url = body.logo_url;
    if (body.logo_width !== undefined) updateData.logo_width = body.logo_width;
    if (body.signature !== undefined) updateData.signature = body.signature;
    if (body.store_name !== undefined) updateData.store_name = body.store_name;

    // Autonomy fields
    if (body.auto_reply_enabled !== undefined) updateData.auto_reply_enabled = body.auto_reply_enabled;
    if (body.auto_refund_enabled !== undefined) updateData.auto_refund_enabled = body.auto_refund_enabled;
    if (body.auto_cancel_enabled !== undefined) updateData.auto_cancel_enabled = body.auto_cancel_enabled;
    if (body.auto_address_change_enabled !== undefined) updateData.auto_address_change_enabled = body.auto_address_change_enabled;
    if (body.auto_reply_delay_minutes !== undefined) updateData.auto_reply_delay_minutes = body.auto_reply_delay_minutes;
    if (body.max_auto_refund_amount !== undefined) updateData.max_auto_refund_amount = body.max_auto_refund_amount;

    const { data, error } = await supabase
      .from('settings')
      .upsert(updateData)
      .select();

    if (error) throw error;
    return NextResponse.json({ message: 'Settings saved!', data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}