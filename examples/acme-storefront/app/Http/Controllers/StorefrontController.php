<?php

namespace App\Http\Controllers;

use App\Exceptions\PaymentDeclinedException;
use App\Jobs\ProcessOrder;
use App\Models\Order;
use App\Models\Product;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

class StorefrontController
{
    public function catalog(): JsonResponse
    {
        $products = Cache::remember('catalog', 60, fn () => Product::orderBy('name')->get());

        return response()->json(['data' => $products]);
    }

    public function product(string $slug): JsonResponse
    {
        return response()->json(['data' => Product::where('slug', $slug)->firstOrFail()]);
    }

    public function checkout(Request $request): JsonResponse
    {
        $data = $request->validate([
            'user_id' => ['required', 'integer'],
            'product' => ['required', 'string'],
            'quantity' => ['required', 'integer', 'min:1', 'max:10'],
            'card' => ['required', 'string'],
        ]);
        $user = User::findOrFail($data['user_id']);
        Auth::setUser($user);
        $product = Product::where('slug', $data['product'])->firstOrFail();

        if ($data['card'] === 'declined') {
            Log::warning('Payment declined', ['user' => $user->id, 'product' => $product->slug]);

            throw new PaymentDeclinedException("Card declined for {$product->name}");
        }

        $order = Order::create([
            'user_id' => $user->id,
            'product_id' => $product->id,
            'quantity' => $data['quantity'],
            'total_cents' => $product->price_cents * $data['quantity'],
            'status' => 'pending',
        ]);
        ProcessOrder::dispatch($order);
        Log::info('Order placed', ['order' => $order->id, 'total_cents' => $order->total_cents]);

        return response()->json(['data' => $order], 201);
    }

    public function order(Order $order): JsonResponse
    {
        return response()->json(['data' => $order->load('product')]);
    }
}
