import { NextResponse } from 'next/server';

// 1. Tell TypeScript to ignore the missing types, and import it normally at the TOP!
// @ts-ignore
import pdf from 'pdf-parse';

export const dynamic = 'force-dynamic';

// 2. Trick the server into thinking browser features exist
if (typeof global !== 'undefined') {
  if (!global.DOMMatrix) global.DOMMatrix = class DOMMatrix {} as any;
  if (!global.Path2D) global.Path2D = class Path2D {} as any;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // Convert the uploaded file into a format Node.js can read
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let extractedText = '';

    // Route logic based on file type
    if (file.name.toLowerCase().endsWith('.pdf')) {
      // 3. Run the clean, un-minified parser!
      const data = await pdf(buffer);
      extractedText = data.text;
    } else {
      // Fallback for standard .txt files
      extractedText = buffer.toString('utf-8');
    }

    // Send the extracted text back to the frontend
    return NextResponse.json({ text: extractedText });
    
  } catch (error: any) {
    console.error('Error parsing document:', error);
    return NextResponse.json({ error: error.message || 'Failed to parse document' }, { status: 500 });
  }
}