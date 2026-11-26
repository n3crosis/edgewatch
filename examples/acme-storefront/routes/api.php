<?php

use App\Http\Controllers\StorefrontController;
use Illuminate\Support\Facades\Route;

Route::get('/catalog', [StorefrontController::class, 'catalog'])->name('catalog.index');
Route::get('/products/{slug}', [StorefrontController::class, 'product'])->name('products.show');
Route::post('/checkout', [StorefrontController::class, 'checkout'])->name('checkout.store');
Route::get('/orders/{order}', [StorefrontController::class, 'order'])->name('orders.show');
