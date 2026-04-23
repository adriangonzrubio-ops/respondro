import { supabaseAdmin } from './supabase';

export interface ProductMatch {
  id: string;
  title: string;
  handle: string | null;
  description: string | null;
  product_type: string | null;
  vendor: string | null;
  tags: string[];
  min_price: number | null;
  max_price: number | null;
  total_inventory: number;
  available: boolean;
  image_url: string | null;
  product_url: string | null;
  rank: number;
}

// Common English + Norwegian stop words we want to ignore in product search
const STOP_WORDS = new Set([
  // English
  'a','an','the','i','my','me','you','your','we','our','is','are','was','were',
  'have','has','had','do','does','did','will','would','can','could','should',
  'about','above','after','again','against','all','am','any','because','been',
  'before','being','below','between','both','but','by','for','from','further',
  'here','how','if','in','into','it','its','just','more','most','no','nor',
  'not','now','of','off','on','once','only','or','other','own','same','so',
  'some','such','than','that','then','there','these','they','this','those',
  'through','to','too','under','until','up','very','what','when','where','which',
  'while','who','whom','why','with','and','as','at','like','want','need','needs',
  'looking','searching','interested','please','thanks','thank','hi','hello','hey',
  'regards','sincerely','dear','cheers','best','would','wondering','order',
  'buy','get','got','take','send','sent','email','message','reply','question',
  'thank','thanks','much','really','still','also','yes','know','let','well','also',
  // Norwegian common words
  'jeg','meg','min','vi','oss','vår','er','var','være','har','hatt',
  'om','for','fra','til','med','på','ved','uten','over','under','etter',
  'før','under','hvor','hva','hvem','hvordan','hvorfor','og','eller','men',
  'ikke','nei','ja','takk','hei','hallo','kjære','vennlig','hilsen',
]);

/**
 * Extract search-worthy keywords from free text and build a Postgres ts_query
 * string. Uses OR (`|`) so we get partial-match recall, then ranking picks best.
 */
function buildTsQuery(text: string): string {
  if (!text) return '';

  // Keep letters (incl. Scandinavian/accented), digits, spaces. Strip everything else.
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const words = cleaned
    .split(' ')
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  // Dedupe + limit so we don't build a massive query
  const unique = Array.from(new Set(words)).slice(0, 12);
  if (unique.length === 0) return '';

  // OR together — ranking handles relevance
  return unique.join(' | ');
}

/**
 * Search products for a store using Postgres full-text search.
 *
 * Safe by design:
 * - Never throws. Always returns an array (possibly empty).
 * - If storeId / query is missing, returns [].
 * - If the DB call fails, logs and returns [].
 */
export async function searchProducts(
  storeId: string | null | undefined,
  query: string | null | undefined,
  limit: number = 5
): Promise<ProductMatch[]> {
  try {
    if (!storeId || !query) return [];

    const tsQuery = buildTsQuery(query);
    if (!tsQuery) return [];

    const { data, error } = await supabaseAdmin.rpc('search_shopify_products', {
      p_store_id: storeId,
      p_query: tsQuery,
      p_limit: Math.max(1, Math.min(limit, 20))
    });

    if (error) {
      console.error('🔍 Product search error:', error.message);
      return [];
    }

    return (data || []) as ProductMatch[];
  } catch (err: any) {
    console.error('🔍 Product search exception:', err?.message || err);
    return [];
  }
}

/**
 * Format product matches as plain-text context suitable for injecting into
 * an AI prompt. Keeps each product compact to save tokens.
 */
export function formatProductsForPrompt(products: ProductMatch[]): string {
  if (!products || products.length === 0) return '';

  return products.map((p, i) => {
    const lines: string[] = [];
    lines.push(`Product ${i + 1}: ${p.title}`);
    if (p.product_type) lines.push(`  Type: ${p.product_type}`);
    if (p.vendor) lines.push(`  Vendor: ${p.vendor}`);
    if (p.min_price != null) {
      const priceStr = (p.max_price != null && p.min_price !== p.max_price)
        ? `${p.min_price}–${p.max_price}`
        : String(p.min_price);
      lines.push(`  Price: ${priceStr}`);
    }
    if (typeof p.total_inventory === 'number') {
      lines.push(`  Stock: ${p.available ? `${p.total_inventory} available` : 'Out of stock'}`);
    }
    if (p.tags && p.tags.length > 0) {
      lines.push(`  Tags: ${p.tags.slice(0, 8).join(', ')}`);
    }
    if (p.description) {
      lines.push(`  Description: ${p.description.substring(0, 400).trim()}`);
    }
    if (p.product_url) lines.push(`  URL: ${p.product_url}`);
    return lines.join('\n');
  }).join('\n\n');
}