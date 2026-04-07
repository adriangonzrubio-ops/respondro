import { NextResponse } from 'next/server';
import { supabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { data: settings } = await supabase.from('settings').select('*').single();
    const { data: connections } = await supabase.from('user_connections').select('*');

    // SaaS-Ready: Check for any variation of a Shopify token
    const shopifyConn = connections?.find(c => c.shopify_access_token || c.access_token || c.shop_url);
    const emailConn = connections?.find(c => c.imap_host || c.gmail_access_token);

    const responseData = {
      rulebook: settings?.rulebook,
      signature: settings?.signature,
      logo_url: settings?.logo_url,
      has_shopify: !!(shopifyConn?.shopify_access_token || shopifyConn?.access_token),
      shop_url: shopifyConn?.shop_url || '',
      has_email: !!emailConn,
      connected_email: emailConn?.email || '',
      imap_host: emailConn?.imap_host || ''
    };

    console.log("📡 API returning settings:", responseData);
    return NextResponse.json(responseData);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST remains the same...
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { rulebook, logo_url, logo_width, signature } = body;

    const { data, error } = await supabase
      .from('settings')
      .upsert({ id: 1, rulebook, logo_url, logo_width, signature })
      .select();

    if (error) throw error;
    return NextResponse.json({ message: 'Settings saved!', data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}