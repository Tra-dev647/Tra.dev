import { prisma } from "@/lib/prisma";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { fetchPaymentStatus } from "@/lib/payment";

export async function GET(
  _req: NextRequest,
  { params }: { params: { orderNumber: string } }
) {
  let order = await prisma.order.findUnique({
    where: { orderNumber: params.orderNumber.toUpperCase() },
    include: {
      game: { select: { name: true, slug: true } },
      product: { select: { name: true } },
    },
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  // Bakong has no webhooks: poll its API while the order is still PENDING.
  if (order.status === "PENDING" && order.paymentRef && !order.paymentRef.startsWith("SIM-")) {
    try {
      const remote = await fetchPaymentStatus(order.paymentRef, { amountUsd: order.amountUsd });
      const isPaid = remote?.paid === true || remote?.status === "paid";
      if (isPaid) {
        order = await prisma.order.update({
          where: { id: order.id },
          data: { status: "PAID", paidAt: new Date() },
          include: {
            game: { select: { name: true, slug: true } },
            product: { select: { name: true } },
          },
        });
      } else if (
        remote &&
        order.paymentExpiresAt &&
        order.paymentExpiresAt.getTime() + 60_000 < Date.now()
      ) {
        order = await prisma.order.update({
          where: { id: order.id },
          data: {
            status: "CANCELLED",
            failureReason: "Bakong QR expired",
          },
          include: {
            game: { select: { name: true, slug: true } },
            product: { select: { name: true } },
          },
        });
      }
    } catch {
      // Silently ignore poll errors â€” we'll retry on the next request.
    }
  }

  return NextResponse.json({
    orderNumber: order.orderNumber,
    status: order.status,
    gameName: order.game.name,
    gameSlug: order.game.slug,
    productName: order.product.name,
    playerUid: order.playerUid,
    serverId: order.serverId,
    amountUsd: order.amountUsd,
    amountKhr: order.amountKhr,
    paymentMethod: order.paymentMethod,
    paymentRef: order.paymentRef,
    paymentUrl: order.paymentUrl,
    qrString: order.qrString,
    paymentExpiresAt: order.paymentExpiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
  });
}
