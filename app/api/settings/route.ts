import { NextResponse } from 'next/server';
import { supabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

// 📥 GET: Pulls settings from the DB when the page loads
export async function GET() {
  try {
    // 1. Get Rulebook & Signature
    const { data: settings } = await supabase.from('settings').select('*').single();
    
    // 2. Get Connections (Shopify & Email)
    const { data: connections } = await supabase.from('user_connections').select('*');

    // Create a "SaaS-Ready" response
    const hasShopify = connections?.some(c => c.shopify_access_token);
    const emailConn = connections?.find(c => c.imap_host || c.gmail_access_token);

    return NextResponse.json({
      rulebook: settings?.rulebook,
      signature: settings?.signature,
      logo_url: settings?.logo_url,
      has_shopify: !!hasShopify,
      shop_url: connections?.find(c => c.shop_url)?.shop_url || '',
      has_email: !!emailConn,
      connected_email: emailConn?.email || '',
      imap_host: emailConn?.imap_host || ''
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 📤 POST: Saves everything (Rulebook, Logo, Signature) in one go
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { rulebook, logo_url, logo_width, signature } = body;

    const { data, error } = await supabase
      .from('settings')
      .upsert({ 
        id: 1, // Use a real ID or shop name here
        rulebook, 
        logo_url, 
        logo_width, 
        signature 
      })
      .select();

    if (error) throw error;
    return NextResponse.json({ message: 'Settings saved!', data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}