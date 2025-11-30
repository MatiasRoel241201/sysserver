import {
    BadRequestException,
    Injectable,
    NotFoundException,
    Inject,
    forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventInventory } from '../entities/event-inventory.entity';
import { EventSupplyInventory } from '../entities/event-supply-inventory.entity';
import { LoadProductInventoryDto } from '../dto/load-product-inventory.dto';
import { UpdateProductInventoryDto } from '../dto/update-product-inventory.dto';
import { EventsService } from '../../events/events.service';
import { ProductsService } from '../../products/products.service';

/**
 * Servicio para gestionar inventario de productos por evento
 */
@Injectable()
export class EventProductInventoryService {
    constructor(
        @InjectRepository(EventInventory)
        private readonly eventInventoryRepository: Repository<EventInventory>,
        @InjectRepository(EventSupplyInventory)
        private readonly eventSupplyInventoryRepository: Repository<EventSupplyInventory>,
        @Inject(forwardRef(() => EventsService))
        private readonly eventsService: EventsService,
        private readonly productsService: ProductsService,
    ) { }

    /**
     * Cargar inventario inicial de productos
     */
    async loadBatch(
        eventId: string,
        loadDto: LoadProductInventoryDto,
    ): Promise<EventInventory[]> {
        // Validar evento
        const event = await this.eventsService.findOne(eventId);
        if (event.isClosed)
            throw new BadRequestException(
                'No se puede cargar inventario en evento cerrado',
            );

        const inventories: EventInventory[] = [];

        for (const item of loadDto.products) {
            // Validar producto
            const product = await this.productsService.findOne(item.productId);
            if (!product.isActive)
                throw new BadRequestException(
                    `El producto "${product.name}" no está activo`,
                );

            // Validar duplicados
            const existing = await this.eventInventoryRepository.findOne({
                where: { eventId, productId: item.productId },
            });
            if (existing)
                throw new BadRequestException(
                    `El producto "${product.name}" ya está en el inventario del evento`,
                );

            // Validar minQty <= initialQty
            if (item.minQty > item.initialQty)
                throw new BadRequestException(
                    `minQty no puede ser mayor que initialQty para "${product.name}"`,
                );

            // Obtener receta del producto
            const recipe = await this.productsService.getSupplies(item.productId);

            let calculatedCost = 0;
            let hasRecipe = false;

            // Verificar si tiene receta
            if (recipe && recipe.length > 0) {
                hasRecipe = true;

                // Si viene el costo desde el frontend, lo usamos (prioridad al usuario/frontend)
                if (item.cost !== undefined && item.cost !== null && item.cost > 0) {
                    calculatedCost = item.cost;
                } else {
                    // Calcular costo sumando (supply.cost × qtyPerUnit) usando costos del evento si existen
                    for (const ps of recipe) {
                        // Buscar si el insumo está en el inventario del evento para usar su costo específico
                        const eventSupply = await this.eventSupplyInventoryRepository.findOne({
                            where: { eventId, supplyId: ps.supplyId }
                        });
                        const supplyCost = eventSupply ? Number(eventSupply.cost) : (ps.supply ? Number(ps.supply.cost) : 0);

                        if (supplyCost > 0) calculatedCost += supplyCost * ps.qtyPerUnit;
                    }
                }
            } else {
                // NO tiene receta - requiere cost manual
                if (item.cost === undefined || item.cost === null) {
                    throw new BadRequestException(
                        `El producto "${product.name}" no tiene receta. Debe proporcionar el campo "cost"`,
                    );
                }
                calculatedCost = item.cost;
            }

            // Calcular margen de ganancia
            let profitMargin = 0;
            if (calculatedCost > 0) {
                profitMargin = ((item.salePrice - calculatedCost) / calculatedCost) * 100;
            } else if (item.salePrice > 0) {
                profitMargin = 100; // Costo 0 y precio > 0 implica 100% (o infinito) de ganancia
            }

            // Crear inventario
            const inventory = this.eventInventoryRepository.create({
                eventId,
                productId: item.productId,
                initialQty: item.initialQty,
                currentQty: item.initialQty,
                minQty: item.minQty,
                cost: calculatedCost,
                salePrice: item.salePrice,
                profitMargin: Number(profitMargin.toFixed(2)),
                hasRecipe,
            });

            inventories.push(inventory);
        }

        return this.eventInventoryRepository.save(inventories);
    }

    /**
     * Listar todo el inventario de productos de un evento
     */
    async findAll(eventId: string): Promise<EventInventory[]> {
        await this.eventsService.findOne(eventId);

        return this.eventInventoryRepository.find({
            where: { eventId, isActive: true },
            relations: ['product'],
            order: { product: { name: 'ASC' } },
        });
    }

    /**
     * Listar solo productos con stock disponible
     */
    async findAvailable(eventId: string): Promise<EventInventory[]> {
        await this.eventsService.findOne(eventId);

        const inventories = await this.eventInventoryRepository
            .createQueryBuilder('inv')
            .leftJoinAndSelect('inv.product', 'product')
            .where('inv.eventId = :eventId', { eventId })
            .andWhere('inv.isActive = :isActive', { isActive: true })
            .andWhere('inv.currentQty > :zero', { zero: 0 })
            .orderBy('product.name', 'ASC')
            .getMany();

        return inventories;
    }

    /**
     * Listar productos con stock bajo (currentQty <= minQty)
     */
    async findLowStock(eventId: string): Promise<EventInventory[]> {
        await this.eventsService.findOne(eventId);

        const inventories = await this.eventInventoryRepository
            .createQueryBuilder('inv')
            .leftJoinAndSelect('inv.product', 'product')
            .where('inv.eventId = :eventId', { eventId })
            .andWhere('inv.isActive = :isActive', { isActive: true })
            .andWhere('inv.currentQty <= inv.minQty')
            .orderBy('inv.currentQty', 'ASC')
            .getMany();

        return inventories;
    }

    /**
     * Obtener inventario de un producto específico
     */
    async findOne(eventId: string, productId: string): Promise<EventInventory> {
        const inventory = await this.eventInventoryRepository.findOne({
            where: { eventId, productId },
            relations: ['product', 'event'],
        });

        if (!inventory) throw new NotFoundException('Inventario no encontrado');
        return inventory;
    }

    /**
     * Actualizar inventario de producto
     */
    async update(
        eventId: string,
        productId: string,
        updateDto: UpdateProductInventoryDto,
    ): Promise<EventInventory> {
        const inventory = await this.findOne(eventId, productId);

        // No permitir modificar eventos cerrados
        if (inventory.event.isClosed)
            throw new BadRequestException(
                'No se puede modificar inventario de evento cerrado',
            );

        // Validar minQty <= initialQty si se actualiza alguno
        const newInitialQty = updateDto.initialQty !== undefined
            ? updateDto.initialQty
            : inventory.initialQty;
        const newMinQty = updateDto.minQty !== undefined
            ? updateDto.minQty
            : inventory.minQty;

        // Convertir a Number para evitar comparación de strings (desde BD PostgreSQL NUMERIC)
        if (Number(newMinQty) > Number(newInitialQty)) {
            throw new BadRequestException(
                'minQty no puede ser mayor que initialQty',
            );
        }

        // No permitir modificar cost de productos con receta
        if (updateDto.cost !== undefined && inventory.hasRecipe)
            throw new BadRequestException(
                'No se puede modificar el costo de un producto con receta. Actualice los costos de los insumos en el catálogo.'
            );

        // Si se actualiza cost o salePrice, recalcular profitMargin
        const newCost = updateDto.cost !== undefined ? updateDto.cost : inventory.cost;
        const newSalePrice =
            updateDto.salePrice !== undefined
                ? updateDto.salePrice
                : inventory.salePrice;

        if (updateDto.cost !== undefined || updateDto.salePrice !== undefined) {
            const profitMargin = ((newSalePrice - newCost) / newCost) * 100;
            updateDto.profitMargin = Number(profitMargin.toFixed(2));
        }

        Object.assign(inventory, updateDto);
        return this.eventInventoryRepository.save(inventory);
    }

    /**
     * Desactivar producto del inventario (soft delete)
     */
    async remove(eventId: string, productId: string): Promise<EventInventory> {
        const inventory = await this.findOne(eventId, productId);

        if (inventory.event.isClosed)
            throw new BadRequestException(
                'No se puede modificar inventario de evento cerrado',
            );
        if (!inventory.isActive)
            throw new BadRequestException('El inventario ya está desactivado');

        inventory.isActive = false;
        return this.eventInventoryRepository.save(inventory);
    }

    /**
     * Descontar stock (uso interno desde Orders)
     */
    async decreaseStock(
        eventId: string,
        productId: string,
        qty: number,
    ): Promise<void> {
        const inventory = await this.findOne(eventId, productId);

        if (inventory.currentQty < qty)
            throw new BadRequestException(
                `Stock insuficiente de "${inventory.product.name}"`,
            );

        inventory.currentQty -= qty;
        await this.eventInventoryRepository.save(inventory);
    }

    /**
     * Aumentar stock (ajustes manuales o devoluciones)
     */
    async increaseStock(
        eventId: string,
        productId: string,
        qty: number,
    ): Promise<void> {
        const inventory = await this.findOne(eventId, productId);

        inventory.currentQty += qty;
        await this.eventInventoryRepository.save(inventory);
    }
}
