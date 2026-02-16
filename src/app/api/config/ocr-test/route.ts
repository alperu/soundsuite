import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/config/ocr-test
 * Test Ollama OCR connection by sending a small synthetic test image.
 * Body: { host: string, model: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { host, model } = body;

    if (!host || !model) {
      return NextResponse.json(
        { error: 'host and model are required' },
        { status: 400 }
      );
    }

    const cleanHost = host.replace(/\/+$/, '');

    // First, check basic connectivity by hitting the Ollama API tags endpoint
    try {
      const tagsRes = await fetch(`${cleanHost}/api/tags`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!tagsRes.ok) {
        return NextResponse.json({
          success: false,
          error: `Ollama returned ${tagsRes.status} from /api/tags`,
        });
      }

      const tags = await tagsRes.json();
      const modelNames = (tags.models || []).map((m: any) => m.name);
      const modelInstalled = modelNames.some((n: string) =>
        n === model || n.startsWith(model + ':') || model.startsWith(n)
      );

      if (!modelInstalled) {
        return NextResponse.json({
          success: false,
          error: `Model "${model}" not found on server. Available: ${modelNames.slice(0, 10).join(', ')}. Run: ollama pull ${model}`,
          availableModels: modelNames,
        });
      }
    } catch (connErr) {
      const msg = connErr instanceof Error ? connErr.message : String(connErr);
      return NextResponse.json({
        success: false,
        error: `Cannot reach Ollama at ${cleanHost}: ${msg}`,
      });
    }

    // Generate a tiny test image (white 100x50 PNG with "TEST" text via sharp)
    let testImageBuffer: Buffer;
    try {
      const sharp = (await import('sharp')).default;
      // Create a simple white image with a black rectangle as test content
      testImageBuffer = await sharp({
        create: {
          width: 200,
          height: 80,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([{
          input: Buffer.from(
            `<svg width="200" height="80">
              <rect x="10" y="10" width="180" height="60" fill="white" stroke="black" stroke-width="2"/>
              <text x="100" y="50" font-family="monospace" font-size="24" text-anchor="middle" fill="black">OCR TEST</text>
            </svg>`
          ),
          top: 0,
          left: 0,
        }])
        .png()
        .toBuffer();
    } catch {
      // Fallback: create a minimal 1x1 PNG if sharp fails
      testImageBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64'
      );
    }

    // Send the test image to the Ollama vision model
    const base64Image = testImageBuffer.toString('base64');
    const startTime = Date.now();

    const generateRes = await fetch(`${cleanHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'Extract all text from this image. Output only the text.',
        images: [base64Image],
        stream: false,
        options: { temperature: 0, num_predict: 256 },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!generateRes.ok) {
      const errText = await generateRes.text();
      return NextResponse.json({
        success: false,
        error: `Ollama generate failed (${generateRes.status}): ${errText}`,
      });
    }

    const generateResult = await generateRes.json();
    const extractedText = (generateResult.response || '').trim();
    const durationMs = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      extractedText,
      durationMs,
      model,
      message: `OCR test completed in ${(durationMs / 1000).toFixed(1)}s. Model responded with ${extractedText.length} chars.`,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
