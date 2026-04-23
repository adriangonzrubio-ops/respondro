import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { decrypt } from '@/lib/encryption';

/**
 * POST /api/shopify/sync-products
 * Body: { storeId: string }
 *
 * Pulls all active products from Shopify and upserts into shopify_products.
 * Handles pagination (Shopify returns max 250 per request).
 * Removes products that no longer exist in Shopify.
 */
export async function POST(req: Request) {
    try {
        const { storeId: bodyStoreId } = await req.json().catch(() => ({}));

        // Resolve store — use provided storeId, or fall back to first store
        let storeId: string | null = bodyStoreId || null;
        if (!storeId) {
            const { data: stores } = await supabaseAdmin.from('stores').select('id').limit(1);
            storeId = stores?.[0]?.id || null;
        }
        if (!storeId) {
            return NextResponse.json({ error: 'No store found' }, { status: 400 });
        }

        // Get Shopify credentials
        const { data: storeInfo } = await supabaseAdmin
            .from('stores')
            .select('shopify_url, shopify_token')
            .eq('id', storeId)
            .single();

        if (!storeInfo?.shopify_url || !storeInfo?.shopify_token) {
            return NextResponse.json({ error: 'Shopify not connected' }, { status: 400 });
        }

        const shop = storeInfo.shopify_url.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const token = decrypt(storeInfo.shopify_token);

        // Track sync start — we'll delete any products not touched by this sync
        const syncStartedAt = new Date().toISOString();

        // Fetch products with pagination via Link header (page_info cursor)
        let allProducts: any[] = [];
        let nextPageInfo: string | null = null;
        let pageCount = 0;
        const MAX_PAGES = 20; // Safety cap — up to 5,000 products

        do {
            pageCount++;
            const url: string = nextPageInfo
                ? `https://${shop}/admin/api/2025-07/products.json?limit=250&page_info=${nextPageInfo}`
                : `https://${shop}/admin/api/2025-07/products.json?limit=250&status=active`;

            const res = await fetch(url, {
                headers: { 'X-Shopify-Access-Token': token }
            });

            if (!res.ok) {
                const errText = await res.text();
                console.error('❌ Shopify products fetch failed:', res.status, errText);
                return NextResponse.json({
                    error: `Shopify API error: ${res.status}`,
                    details: errText.substring(0, 200)
                }, { status: 500 });
            }

            const data = await res.json();
            const products = data.products || [];
            allProducts = allProducts.concat(products);

            // Parse Link header for pagination cursor
            const linkHeader = res.headers.get('link') || res.headers.get('Link');
            nextPageInfo = null;
            if (linkHeader && linkHeader.includes('rel="next"')) {
                const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
                if (nextMatch) nextPageInfo = nextMatch[1];
            }
        } while (nextPageInfo && pageCount < MAX_PAGES);

        console.log(`🛍️ Fetched ${allProducts.length} products from Shopify (${pageCount} page${pageCount === 1 ? '' : 's'})`);

        // Transform Shopify products → our schema + upsert
        let upsertedCount = 0;
        for (const p of allProducts) {
            try {
                const variants = Array.isArray(p.variants) ? p.variants : [];
                const prices = variants
                    .map((v: any) => parseFloat(v.price))
                    .filter((n: number) => !isNaN(n));
                const totalInventory = variants.reduce(
                    (sum: number, v: any) => sum + (parseInt(v.inventory_quantity, 10) || 0),
                    0
                );
                const hasStock = variants.some(
                    (v: any) => (parseInt(v.inventory_quantity, 10) || 0) > 0
                );

                // Strip HTML from description
                const plainDescription = (p.body_html || '')
                    .replace(/<[^>]*>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .substring(0, 5000); // Cap at 5k chars to keep rows lean

                // Tags: Shopify returns comma-separated string
                const tagArray = typeof p.tags === 'string'
                    ? p.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                    : Array.isArray(p.tags) ? p.tags : [];

                // Simplified variant data for the AI (we don't need everything)
                const slimVariants = variants.map((v: any) => ({
                    id: v.id,
                    sku: v.sku || null,
                    title: v.title || null,
                    price: v.price || null,
                    inventory: v.inventory_quantity ?? null,
                    option1: v.option1 || null,
                    option2: v.option2 || null,
                    option3: v.option3 || null
                }));

                const row = {
                    store_id: storeId,
                    shopify_product_id: p.id,
                    title: p.title || 'Untitled',
                    handle: p.handle || null,
                    description: plainDescription || null,
                    product_type: p.product_type || null,
                    vendor: p.vendor || null,
                    tags: tagArray,
                    status: p.status || 'active',
                    image_url: p.image?.src || null,
                    product_url: p.handle ? `https://${shop}/products/${p.handle}` : null,
                    variants: slimVariants,
                    min_price: prices.length > 0 ? Math.min(...prices) : null,
                    max_price: prices.length > 0 ? Math.max(...prices) : null,
                    total_inventory: totalInventory,
                    available: hasStock,
                    last_synced_at: new Date().toISOString()
                };

                const { error: upsertErr } = await supabaseAdmin
                    .from('shopify_products')
                    .upsert(row, { onConflict: 'store_id,shopify_product_id' });

                if (upsertErr) {
                    console.error(`❌ Upsert failed for product ${p.id}:`, upsertErr.message);
                } else {
                    upsertedCount++;
                }
            } catch (productErr: any) {
                console.error(`❌ Product processing error for ${p?.id}:`, productErr.message);
            }
        }

        // Clean up: remove products that weren't touched by this sync
        // (means they were deleted or unpublished on Shopify)
        const { error: cleanupErr, count: removedCount } = await supabaseAdmin
            .from('shopify_products')
            .delete({ count: 'exact' })
            .eq('store_id', storeId)
            .lt('last_synced_at', syncStartedAt);

        if (cleanupErr) {
            console.error('⚠️ Cleanup error (non-blocking):', cleanupErr.message);
        }

        return NextResponse.json({
            success: true,
            synced: upsertedCount,
            removed: removedCount || 0,
            totalFetched: allProducts.length,
            pages: pageCount
        });

    } catch (error: any) {
        console.error('❌ Sync products error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/**
 * GET /api/shopify/sync-products?storeId=...
 * Returns current sync status (product count + last synced time).
 * Used by the UI to show "X products synced, last updated Y".
 */
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        let storeId = searchParams.get('storeId');

        if (!storeId) {
            const { data: stores } = await supabaseAdmin.from('stores').select('id').limit(1);
            storeId = stores?.[0]?.id || null;
        }
        if (!storeId) {
            return NextResponse.json({ count: 0, lastSyncedAt: null });
        }

        const { count } = await supabaseAdmin
            .from('shopify_products')
            .select('id', { count: 'exact', head: true })
            .eq('store_id', storeId);

        const { data: latest } = await supabaseAdmin
            .from('shopify_products')
            .select('last_synced_at')
            .eq('store_id', storeId)
            .order('last_synced_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        return NextResponse.json({
            count: count || 0,
            lastSyncedAt: latest?.last_synced_at || null
        });

    } catch (error: any) {
        console.error('❌ Sync status error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}