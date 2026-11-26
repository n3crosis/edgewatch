<?php

namespace Database\Seeders;

use App\Models\Product;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        foreach (['Maya Lin', 'Daniel Park', 'Hannah Brooks', 'Omar Farooq', 'Clara Morales', 'Yuki Sato'] as $name) {
            User::create([
                'name' => $name,
                'email' => strtolower(strtok($name, ' ')).'@acme-storefront.test',
                'password' => Hash::make('password'),
            ]);
        }

        foreach ([
            ['studio-headphones', 'Studio Headphones', 19900],
            ['travel-mug', 'Travel Mug', 2400],
            ['desk-lamp', 'Desk Lamp', 5900],
            ['wool-throw', 'Wool Throw', 8900],
            ['notebook-set', 'Notebook Set', 1800],
        ] as [$slug, $name, $price]) {
            Product::create(['slug' => $slug, 'name' => $name, 'price_cents' => $price]);
        }
    }
}
