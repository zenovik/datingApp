import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(compression());

  // In production, pin CORS to the deployed frontend's origin (same var
  // used to build links in emails). In dev, reflect any origin on port 4200
  // (localhost or a LAN IP) so the same backend works for a browser on this
  // machine or a phone on the same network hitting the dev server's LAN address.
  app.enableCors({
    origin:
      process.env.NODE_ENV === 'production'
        ? process.env.FRONTEND_URL
        : /^http:\/\/(localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):4200$/,
    credentials: true,
  });

  // Uploaded files are named with a random UUID and never overwritten with
  // different content at the same URL (deletion removes the row, it doesn't
  // reuse the filename), so it's safe to cache them aggressively.
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
    maxAge: '30d',
    immutable: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('LoveFox API')
    .setDescription('REST API for the LoveFox platform')
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 8000;
  await app.listen(port, '0.0.0.0');
}
void bootstrap();
